/**
 * 启动定位策略的烟测（app.js）。
 *
 * 用户反馈：「每次进小程序需要重新定位」。查下来是两条叠在一起：
 *   1. 旧实现把「用户手动选过城市」落成 dh_city_manual，一旦为真就**永久**停掉自动定位；
 *   2. 「跟随有预约的城市」那次切城没带来源，把这个标记又悄悄抹成 false ——
 *      于是用户手动选的城市保不住，还得每次进来重选。
 *
 * 现在的口径（用户明确要求「每次进小程序都定位到当前位置」）：
 *   - 每次启动都真定位一次，老标记不再拦；
 *   - 用户**本次会话**自己选过城市 → 迟到的定位结果不许覆盖他；
 *   - 定位失败/没权限 → 静默回落上次的城市，不弹错、不打扰。
 *
 *   /usr/local/bin/node tools/smoke-locate-policy.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

const store = new Map();
global.wx = new Proxy(
  {
    getStorageSync: (k) => (store.has(k) ? store.get(k) : ""),
    setStorageSync: (k, v) => store.set(k, v),
    removeStorageSync: (k) => store.delete(k),
    cloud: undefined,
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let appCfg = null;
global.App = (cfg) => {
  appCfg = cfg;
};
global.Page = () => {};
global.Component = () => {};
global.Behavior = (c) => c;
global.getApp = () => fakeApp;

const CITIES = [
  { id: 1, region: "CN", name: "上海" },
  { id: 3, region: "CN", name: "深圳" },
  { id: 5, region: "CN", name: "杭州" },
];

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    apiLogin: async () => ({ token: "t" }),
    apiCities: async () => CITIES,
    apiSubscribeConfig: async () => ({ classReminderTplId: "" }),
  },
};

/** locate 模块按用例换实现 */
let locateImpl = async () => ({ code: "ok", city: CITIES[2] });
let locateArgs = [];
const locatePath = require.resolve(path.join(MINIAPP, "utils/locate.js"));
require.cache[locatePath] = {
  id: locatePath,
  filename: locatePath,
  loaded: true,
  exports: {
    locateCity: (opts) => {
      locateArgs.push(opts);
      return locateImpl(opts);
    },
    readLocateCache: () => null,
    readOriginCache: () => null,
    getOrigin: async () => null,
    openSetting: async () => "denied",
    LOCATE_SCOPE: "scope.userFuzzyLocation",
  },
};

require(path.join(MINIAPP, "app.js"));

/** 把 App 配置里的方法挂到一个独立实例上（app.js 的方法都用 this.xxx 互调） */
function makeApp() {
  const a = Object.assign({}, appCfg);
  a.globalData = JSON.parse(JSON.stringify(appCfg.globalData));
  return a;
}
const fakeApp = makeApp();

let failed = 0;
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${g}，期望 ${w}`}`);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function resetApp() {
  fakeApp.globalData = JSON.parse(JSON.stringify(appCfg.globalData));
  fakeApp.globalData.cities = CITIES;
  fakeApp.globalData.cityId = 1;
  fakeApp.globalData.region = "CN";
  locateArgs = [];
}

(async () => {
  console.log("\n[1] 启动时用上次的城市做首屏，不闪");
  store.clear();
  store.set("dh_region", "CN");
  store.set("dh_cityId", 3);
  locateImpl = async () => ({ code: "denied" }); // 定位这一趟先不参与，单看首屏
  await appCfg.doInit.call(fakeApp);
  await settle();
  check("首屏城市 = 上次用的深圳", fakeApp.globalData.cityId, 3);
  check("「本次会话手动选过」被重置", fakeApp.globalData.cityManual, false);

  console.log("\n[2] 老标记不再拦定位（旧版本存过 dh_city_manual=true 的用户要能自愈）");
  store.set("dh_city_manual", true);
  resetApp();
  fakeApp.globalData.cities = CITIES;
  locateImpl = async () => ({ code: "ok", city: CITIES[2] });
  appCfg.locateInBackground.call(fakeApp);
  await settle();
  check("每次都真定位（没有走缓存）", locateArgs, [{ useCache: false }]);
  check("定位到杭州 → 城市跟着走", fakeApp.globalData.cityId, 5);
  check("课表页会被通知切换", fakeApp.globalData.locatedCity && fakeApp.globalData.locatedCity.id, 5);

  console.log("\n[3] 用户本次会话自己选过城市 → 迟到的定位结果不许覆盖");
  resetApp();
  fakeApp.globalData.cities = CITIES;
  appCfg.setCity.call(fakeApp, "CN", 3, "manual"); // 用户手动切到深圳
  appCfg.locateInBackground.call(fakeApp);
  await settle();
  check("还是用户选的深圳", fakeApp.globalData.cityId, 3);
  check("没有多弹一次「已定位到」", fakeApp.globalData.locatedCity, null);

  console.log("\n[4] 定位失败 / 没权限 → 静默，不打扰");
  resetApp();
  fakeApp.globalData.cities = CITIES;
  locateImpl = async () => ({ code: "denied" });
  appCfg.locateInBackground.call(fakeApp);
  await settle();
  check("城市不动", fakeApp.globalData.cityId, 1);
  check("不写 locatedCity", fakeApp.globalData.locatedCity, null);

  console.log("\n[5] 定位成功但就是当前城市 → 不重复切、不弹提示");
  resetApp();
  fakeApp.globalData.cities = CITIES;
  locateImpl = async () => ({ code: "ok", city: CITIES[0] }); // 上海 = 当前
  appCfg.locateInBackground.call(fakeApp);
  await settle();
  check("城市不变", fakeApp.globalData.cityId, 1);
  check("不打扰", fakeApp.globalData.locatedCity, null);

  console.log("\n[6] 城市已经下架 → 回落到国内第一个城市");
  store.clear();
  store.set("dh_region", "CN");
  store.set("dh_cityId", 999);
  resetApp();
  await appCfg.doInit.call(fakeApp);
  check("回落", fakeApp.globalData.cityId, 1);

  console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
  process.exit(failed ? 1 : 0);
})();
