/**
 * 课表页「切 tab 回来」生命周期烟测（pages/index）。
 *
 * 用户反馈：冷启动时课表显示【定位城市】+【你在深圳还有 3 节预约 →】提示条；
 * 点「我的」再切回课表，提示条没了，只剩定位城市。
 *
 * 这类顺序竞态（app.onLaunch 异步 init / 后台定位迟到 / onShow 分支互相 return）
 * 光看代码推不出来，必须把 Page 抓下来按真实时间线回放。
 *
 * 回放两条真实时间线：
 *   A) doInit 快：page.onLoad 时 globalData.cityId 已就绪（=上次城市），定位后到
 *   B) doInit 慢：page.onLoad 时 cityId 还是 null，之后 doInit + 定位才落地
 * 每条线都跑完整流程：onLoad → 定位落地 → onShow → （点提示条）→ 去「我的」→ 回课表。
 *
 *   /Users/nnnnnnxf/.workbuddy/binaries/node/versions/22.22.2-3/bin/node tools/smoke-index-tab-return.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");
const { dateKey, addDays } = require(path.join(MINIAPP, "utils/date.js"));

global.wx = new Proxy(
  {
    getSystemInfoSync: () => ({ windowHeight: 667, safeArea: { bottom: 647 } }),
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: ({ title }) => {
      global.__toast = title;
    },
    navigateTo: () => {},
    switchTab: () => {},
    stopPullDownRefresh: () => {},
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

const CITIES = [
  { id: 1, region: "CN", name: "深圳" },
  { id: 2, region: "CN", name: "三亚" },
  { id: 3, region: "CN", name: "广州" },
];

const setCityCalls = [];
const appMock = {
  globalData: { cities: CITIES, cityId: null, region: "CN", dirty: 0 },
  setCity: (region, cityId, source) => {
    appMock.globalData.region = region;
    appMock.globalData.cityId = cityId;
    if (source === "manual") appMock.globalData.cityManual = true;
    setCityCalls.push([region, cityId, source || null]);
  },
};
global.getApp = () => appMock;

const dayAt = (n) => dateKey(addDays(new Date(), n));
/** 预约全在深圳：3 节今天/未来 → 定位到三亚时该出提示条 */
const bookings = [
  { schedule: { city: "深圳", scheduleDate: dayAt(0) } },
  { schedule: { city: "深圳", scheduleDate: dayAt(0) } },
  { schedule: { city: "深圳", scheduleDate: dayAt(1) } },
];

/** 课表按城市返回，断言「课表里到底渲染了谁」用 */
const TIMELINE = {
  1: [{ id: 11, courseName: "编舞", startTime: "14:00", studio: { id: 101, short: "CLAP", name: "CLAP" } }],
  2: [],
  3: [],
};

const fakeApi = {
  ensureReady: async () => {},
  apiTimeline: async (cityId) => ({ items: TIMELINE[cityId] || [] }),
  apiFollows: async () => [],
  apiBookings: async () => bookings,
};

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/index/index.js"));

function makePage() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) {
      if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
      page.data[k] = patch[k];
    }
  };
  page.selectComponent = () => null;
  page.currentDate = new Date();
  return page;
}

let failed = 0;
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${g}，期望 ${w}`}`);
}

const hintName = (p) => (p.data.cityHint ? p.data.cityHint.name : null);
const cityName = (p) => (CITIES.find((c) => c.id === p.data.cityId) || {}).name || null;

/** 模拟用户切到「我的」再切回课表：中间只有 profile.onShow 的只读操作，切换本身不碰 globalData */
const visitProfileAndBack = async (page) => {
  await page.onHide && (await page.onHide());
  await page.onShow();
};

(async () => {
  console.log("\n[A] doInit 快：onLoad 时 cityId 已是上次城市（深圳），定位后到（三亚）");
  setCityCalls.length = 0;
  appMock.globalData.cityId = 1; // 上次城市 = 深圳
  appMock.globalData.cityManual = false;
  delete appMock.globalData.locatedCity;
  let page = makePage();
  await page.onLoad();
  check("首屏渲染上次城市（深圳）", cityName(page), "深圳");

  // 后台定位落地：app.locateInBackground 的行为 = setCity(locate) + locatedCity
  appMock.setCity("CN", 2, "locate");
  appMock.globalData.locatedCity = { id: 2, region: "CN", name: "三亚" };
  await page.onShow();
  check("切到定位城市（三亚）", cityName(page), "三亚");
  check("提示条指向预约城市（深圳）3 节", [hintName(page), page.data.cityHint && page.data.cityHint.count], ["深圳", 3]);

  console.log("\n[A2] 去「我的」再回课表 → 提示条还在吗？");
  await visitProfileAndBack(page);
  check("城市不被拽走（仍在三亚）", cityName(page), "三亚");
  check("提示条还在（这屏没有其他解释入口）", hintName(page), "深圳");

  console.log("\n[A3] 点提示条切过去 → 去「我的」→ 回课表");
  global.__toast = "";
  await page.tapCityHint();
  check("切到深圳", cityName(page), "深圳");
  check("课表渲染的是深圳的课", (page.data.items || []).map((i) => i.id), [11]);
  check("提示条收起（当前城市就有预约）", page.data.cityHint, null);
  await visitProfileAndBack(page);
  check("回来仍在深圳（不被定位拽回）", cityName(page), "深圳");
  check("课表还是深圳的课", (page.data.items || []).map((i) => i.id), [11]);

  console.log("\n[B] doInit 慢：onLoad 时 cityId 还是 null，之后 doInit+定位才落地");
  setCityCalls.length = 0;
  appMock.globalData.cityId = null;
  appMock.globalData.cityManual = false;
  delete appMock.globalData.locatedCity;
  page = makePage();
  await page.onLoad();
  check("此时没有城市可选", cityName(page), null);

  // doInit 完成：globalData.cityId = 上次城市，随后定位落地三亚
  appMock.globalData.cityId = 1;
  appMock.setCity("CN", 2, "locate");
  appMock.globalData.locatedCity = { id: 2, region: "CN", name: "三亚" };
  await page.onShow();
  check("切到定位城市（三亚）", cityName(page), "三亚");
  check("提示条指向深圳 3 节", hintName(page), "深圳");

  await visitProfileAndBack(page);
  check("切 tab 回来：城市仍在三亚", cityName(page), "三亚");
  check("切 tab 回来：提示条还在", hintName(page), "深圳");

  console.log("\n[C] 手动切城市（chip / 城市面板）→ 提示条必须跟着重算");
  // 旧代码只在 onShow 里碰运气重算：手动切城后提示条会留着过期文案
  //（人都到深圳了，还写着「你在深圳还有 3 节预约」）。
  await page.applyCity(1); // 手动切到预约城市
  check("手动切到深圳", cityName(page), "深圳");
  check("提示条收起（当前城市就有预约）", page.data.cityHint, null);

  await page.applyCity(3); // 再切到没有预约的广州
  check("手动切到广州", cityName(page), "广州");
  check("提示条重算出来（指向深圳 3 节）", hintName(page), "深圳");
  check("计数仍是 3", page.data.cityHint && page.data.cityHint.count, 3);

  await page.applyCity(2); // 回到定位城市
  check("再切回三亚", cityName(page), "三亚");
  check("提示条仍指向深圳", hintName(page), "深圳");

  console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
  process.exit(failed ? 1 : 0);
})();
