/**
 * 课表页「只看已约」+ 已约置顶烟测。
 *
 * 小程序页面没法在 Node 里真跑，这里 mock 掉 wx 与 services/api，
 * 把页面对象抓下来手动喂课表数据，验证：
 *   1. 已约课恒定置顶（已约好 > 待确认 > 没约），同档内保持时间顺序
 *   2. 打开「只看已约」→ 只剩已约的课；关掉 → 全部回来
 *   3. bookedCount 算的是全量（含被屏蔽的课），开关上写的数字不能跟着隐藏状态变
 *   4. 翻到一节已约都没有的那天，开关自动关掉（否则就是一片空白）
 *   5. 开关与门店/舞种筛选能叠加，互不打架
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

global.wx = new Proxy(
  {
    getSystemInfoSync: () => ({ windowHeight: 667, safeArea: { bottom: 647 } }),
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: ({ title }) => {
      global.__toast = title;
    },
    navigateTo: ({ url }) => {
      global.__lastUrl = url;
    },
    stopPullDownRefresh: () => {},
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({
  globalData: { cities: [], dirty: 0 },
  setCity: () => {},
});
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

/** 5 节课：只有 id2(PENDING) 和 id4(CONFIRMED) 是已约的，且都不是最早那节 */
const BOOKED = [
  { id: 1, courseName: "Jazz基础", startTime: "10:00", studio: { id: 101, short: "甲店", name: "甲店" }, bookingStatus: null },
  { id: 2, courseName: "Hiphop入门", startTime: "11:00", studio: { id: 102, short: "乙店", name: "乙店" }, bookingStatus: "PENDING" },
  { id: 3, courseName: "古典舞身韵", startTime: "12:00", studio: { id: 101, short: "甲店", name: "甲店" }, bookingStatus: null },
  { id: 4, courseName: "Jazz编舞", startTime: "13:00", studio: { id: 102, short: "乙店", name: "乙店" }, bookingStatus: "CONFIRMED" },
  { id: 5, courseName: "早功", startTime: "14:00", studio: { id: 101, short: "甲店", name: "甲店" }, bookingStatus: null },
];

/** 同一天，但没有一节是已约的 */
const PLAIN = BOOKED.map((c) => ({ ...c, bookingStatus: null }));

let feed = BOOKED;
const fakeApi = {
  ensureReady: async () => {},
  apiTimeline: async () => ({ items: feed }),
  apiFollows: async () => [],
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

const ids = (page) => (page.data.items || []).map((i) => i.id);

(async () => {
  const page = makePage();
  page.currentDate = new Date();
  page.data.cityId = 13;
  await page.load();

  check("全部 5 节", page.data.items.length, 5);
  check("已约计数（含待确认）", page.data.bookedCount, 2);
  check("默认不只看已约", page.data.onlyBooked, false);
  // 置顶：13:00 的 CONFIRMED 排最前，11:00 的 PENDING 第二，其余按时间
  check("已约课置顶（已约好 > 待确认 > 未约）", ids(page), [4, 2, 1, 3, 5]);

  await page.toggleOnlyBooked();
  check("打开「只看已约」", page.data.onlyBooked, true);
  check("只剩已约的两节", ids(page), [4, 2]);

  // 与门店筛选叠加：只留甲店（101）→ 甲店这天没有已约的课
  await page.tapStoreChip({ currentTarget: { dataset: { id: "102" } } });
  check("只看已约 + 只留甲店 = 空", ids(page), []);
  check("空态归因为被筛掉（不是这天没课）", page.data.emptyFiltered, true);

  await page.tapAllStores();
  check("恢复全部门店后仍是 2 节", ids(page), [4, 2]);

  await page.toggleOnlyBooked();
  check("关掉开关回到 5 节（顺序仍是已约在前）", ids(page), [4, 2, 1, 3, 5]);

  // 翻到一节已约都没有的那天：开关会自动关掉，不能留一片空白
  await page.toggleOnlyBooked();
  check("翻天前开关是开的", page.data.onlyBooked, true);
  feed = PLAIN;
  await page.load();
  check("这天没有已约 → 开关自动关掉", page.data.onlyBooked, false);
  check("这天没有已约 → 计数归零", page.data.bookedCount, 0);
  check("这天没有已约 → 课表照常显示 5 节", page.data.items.length, 5);

  console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
  process.exit(failed ? 1 : 0);
})();
