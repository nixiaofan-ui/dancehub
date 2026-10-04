/**
 * 课表页「预约在别座城市」提示条烟测（pages/index）。
 *
 * 这块原来是**直接把城市切过去**。用户反馈「每次进来城市都不是我选的」，
 * 定位和「按预约切城」互相打架是主因之一 —— 人明明在上海，课表被拽去北京，
 * 观感就是「我选的城市又被吞了」。
 *
 * 现在的口径：只提示、不切城市。这个烟测把三条边界钉死：
 *   1. 预约在别城 → 出提示条，但 cityId 一动不动（不许偷偷切）
 *   2. 点提示条 → 才切，并且按 manual 记（本次会话不再被迟到的定位盖掉）
 *   3. 当前城市本来就有预约 / 只有过期的预约 / 接口挂了 / 用户关掉过 → 都不出提示
 *
 *   /usr/local/bin/node tools/smoke-index-city-hint.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");
const { dateKey, addDays, todayKey: today } = require(path.join(MINIAPP, "utils/date.js"));

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
  { id: 1, region: "CN", name: "上海" },
  { id: 2, region: "CN", name: "北京" },
];

const setCityCalls = [];
// ⚠ index.js 在模块顶层就 `const app = getApp()`，必须是单例，
//   后面用例才能往 globalData 里塞 locatedCity（每次新建对象的话塞不进去）
const appMock = {
  globalData: { cities: CITIES, cityId: 1, region: "CN", dirty: 0 },
  setCity: (region, cityId, source) => setCityCalls.push([region, cityId, source || null]),
};
global.getApp = () => appMock;

/** 相对今天生成，别写死日期 —— 写死的「今天」过几天就不是今天了 */
const dayAt = (n) => dateKey(addDays(new Date(), n));

/** 接口返回的预约列表，按用例替换 */
let bookings = [];
let bookingsFails = false;
const fakeApi = {
  ensureReady: async () => {},
  apiTimeline: async () => ({ items: [] }),
  apiFollows: async () => [],
  apiBookings: async () => {
    if (bookingsFails) throw new Error("连不上服务");
    return bookings;
  },
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
  page.load = async () => {}; // 这个烟测只看城市与提示条，不跑课表请求
  page.data.cityId = 1;
  page.data.region = "CN";
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

/** [{ city:'北京', day:'2026-10-08' }] → apiBookings 的形状 */
const bk = (city, day) => ({ schedule: { city, scheduleDate: day } });

(async () => {
  console.log("\n[1] 当前城市没有预约、北京有 2 节未来课 → 只出提示条，不切城市");
  setCityCalls.length = 0;
  bookings = [bk("北京", dayAt(3)), bk("北京", dayAt(5)), bk("上海", dayAt(-3))];
  let page = makePage();
  await page.checkBookedCityHint();
  check("提示条内容", page.data.cityHint && {
    name: page.data.cityHint.name,
    count: page.data.cityHint.count,
  }, { name: "北京", count: 2 });
  check("城市一动不动", page.data.cityId, 1);
  check("没有偷偷调 setCity", setCityCalls, []);

  console.log("\n[2] 点提示条 → 这时候才切，并按 manual 记");
  global.__toast = "";
  await page.tapCityHint();
  check("切到北京", page.data.cityId, 2);
  check("setCity 带 manual（本次会话不再被迟到定位盖掉）", setCityCalls, [["CN", 2, "manual"]]);
  check("提示条收起", page.data.cityHint, null);
  check("有交代", global.__toast, "已切到北京");

  console.log("\n[3] 当前城市本来就有预约 → 不出提示");
  bookings = [bk("上海", dayAt(1)), bk("北京", dayAt(4))];
  page = makePage();
  await page.checkBookedCityHint();
  check("不提示", page.data.cityHint, null);

  console.log("\n[4] 只有过去的预约 → 不出提示（上过的课不该一直挂着）");
  bookings = [bk("北京", dayAt(-1)), bk("北京", dayAt(-9))];
  page = makePage();
  await page.checkBookedCityHint();
  check("不提示", page.data.cityHint, null);

  console.log("\n[5] 用户点了 ✕ → 本次会话不再出现");
  bookings = [bk("北京", dayAt(2))];
  page = makePage();
  await page.checkBookedCityHint();
  check("先出提示", page.data.cityHint && page.data.cityHint.count, 1);
  page.dismissCityHint();
  check("关掉后收起", page.data.cityHint, null);
  await page.checkBookedCityHint();
  check("再算也不出", page.data.cityHint, null);
  check("依然没切城市", page.data.cityId, 1);

  console.log("\n[6] 接口挂了 / 没有预约 → 静默，不弹错不切城");
  bookingsFails = true;
  page = makePage();
  await page.checkBookedCityHint();
  check("接口挂了不出提示", page.data.cityHint, null);
  bookingsFails = false;
  bookings = [];
  page = makePage();
  await page.checkBookedCityHint();
  check("没预约不出提示", page.data.cityHint, null);

  console.log("\n[7] 上一轮留下的提示要能撤掉（当前城市后来有了预约）");
  bookings = [bk("北京", dayAt(2))];
  page = makePage();
  await page.checkBookedCityHint();
  check("先出提示", !!page.data.cityHint, true);
  page.data.cityId = 2; // 用户自己切到北京了
  bookings = [bk("北京", dayAt(2))];
  await page.checkBookedCityHint();
  check("当前城市有预约 → 提示撤掉", page.data.cityHint, null);

  console.log("\n[8] 后台定位落地自动切城 → 切完当屏就要提示「预约在原城市」");
  // 线上场景：人在三亚（定位切过去），预约全在深圳 —— 旧代码在这个分支
  // 直接 return，跳过 checkBookedCityHint，用户看到一屏解释不了的空白。
  setCityCalls.length = 0;
  bookings = [bk("上海", dayAt(1)), bk("上海", dayAt(2))]; // 预约在原来的城市
  page = makePage();
  page.data.cityId = 1; // 当前在上海
  appMock.globalData.locatedCity = { id: 2, region: "CN", name: "北京" }; // 定位落地北京
  global.__toast = "";
  await page.onShow();
  check("按定位切到北京", page.data.cityId, 2);
  check("当屏就出提示条（预约还在上海）", page.data.cityHint && {
    name: page.data.cityHint.name,
    count: page.data.cityHint.count,
  }, { name: "上海", count: 2 });
  check("有定位交代", global.__toast, "已定位到北京");
  delete appMock.globalData.locatedCity;

  console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
  process.exit(failed ? 1 : 0);
})();
