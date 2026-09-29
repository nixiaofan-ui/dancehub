/**
 * 首页（pages/index）两级筛选烟测：门店 → 舞种。
 *
 * 小程序页面没法在 Node 里真跑，这里 mock 掉 wx 与 services/api，
 * 把页面对象抓下来手动喂课表数据，验证：
 *   1. 舞种条只在「真的有多个舞种」时出现（只有一种时不该给没用的开关）
 *   2. 认不出舞种的课归到「其它」，不会被悄悄筛掉
 *   3. 取消勾选某舞种 → 课表立刻少掉那一批，且支持多选
 *   4. 至少保留一个舞种（全取消会让界面一片空白且无法解释）
 *   5. 两级筛选可叠加：门店 + 舞种同时生效
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

/** 8 节课：Jazz×3、HipHop×2、中国舞×1、认不出×2；分属两家门店 */
// startTime 必填：load() 会按它算「已过时」，缺字段会直接把整批课吞掉
const COURSES = [
  { id: 1, courseName: "进阶jazz（A教室）", startTime: "10:00", studio: { id: 101, short: "甲店", name: "甲店" } },
  { id: 2, courseName: "JAZZ基础", startTime: "11:00", studio: { id: 102, short: "乙店", name: "乙店" } },
  { id: 3, courseName: "Jazz编舞", startTime: "12:00", studio: { id: 101, short: "甲店", name: "甲店" } },
  { id: 4, courseName: "Hiphop入门", startTime: "13:00", studio: { id: 102, short: "乙店", name: "乙店" } },
  { id: 5, courseName: "HIPHOP提高", startTime: "14:00", studio: { id: 101, short: "甲店", name: "甲店" } },
  { id: 6, courseName: "古典舞身韵", startTime: "15:00", studio: { id: 102, short: "乙店", name: "乙店" } },
  { id: 7, courseName: "早功", startTime: "16:00", studio: { id: 101, short: "甲店", name: "甲店" } },
  { id: 8, courseName: "私教课", startTime: "17:00", studio: { id: 102, short: "乙店", name: "乙店" } },
];

const fakeApi = {
  ensureReady: async () => {},
  apiTimeline: async () => ({ items: COURSES }),
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

const labels = (page) => (page.data.styleChips || []).map((c) => `${c.label}:${c.count}`);
const ids = (page) => (page.data.items || []).map((i) => i.id);

(async () => {
  const page = makePage();
  page.currentDate = new Date();
  // 跳过 onLoad（它会走定位/城市逻辑），只跑数据那条路
  page.data.cityId = 13;
  await page.load();

  check("课表条数", page.data.items.length, 8);
  check("门店筛选条出现", page.data.showStoreBar, true);
  check("舞种筛选条出现", page.data.showStyleBar, true);
  check("舞种按课数降序（认不出的归「其它」）", labels(page), [
    "Jazz:3",
    "HipHop:2",
    "其它:2",
    "中国舞:1",
  ]);
  check("默认全选", page.data.styleAllOn, true);

  // 只看 Jazz
  await page.tapAllStyles();
  await page.tapStyleChip({ currentTarget: { dataset: { label: "HipHop" } } });
  await page.tapStyleChip({ currentTarget: { dataset: { label: "其它" } } });
  await page.tapStyleChip({ currentTarget: { dataset: { label: "中国舞" } } });
  check("只剩 Jazz（多选逐个取消）", ids(page), [1, 2, 3]);

  // 至少保留一个：再取消 Jazz 应被拦下
  global.__toast = "";
  await page.tapStyleChip({ currentTarget: { dataset: { label: "Jazz" } } });
  check("取消最后一个舞种被拦下", global.__toast, "至少保留一个舞种");
  check("被拦下后课表不变", ids(page), [1, 2, 3]);

  // 两级叠加：门店只留乙店 + 舞种 Jazz
  await page.tapAllStyles();
  await page.tapStoreChip({ currentTarget: { dataset: { id: "101" } } });
  await page.tapStyleChip({ currentTarget: { dataset: { label: "HipHop" } } });
  await page.tapStyleChip({ currentTarget: { dataset: { label: "其它" } } });
  await page.tapStyleChip({ currentTarget: { dataset: { label: "中国舞" } } });
  check("门店(乙店) + 舞种(Jazz) 叠加", ids(page), [2]);

  // 全部恢复
  await page.tapAllStores();
  await page.tapAllStyles();
  check("全选后恢复 8 节", ids(page), [1, 2, 3, 4, 5, 6, 7, 8]);

  // 只有一种舞种时不该给筛选条
  const page2 = makePage();
  page2.currentDate = new Date();
  page2.data.cityId = 13;
  page2.syncStyleChips([
    { id: 1, courseName: "jazz A" },
    { id: 2, courseName: "jazz B" },
  ]);
  check("只有一种舞种时不显示筛选条", page2.data.showStyleBar, false);

  console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
  process.exit(failed ? 1 : 0);
})();
