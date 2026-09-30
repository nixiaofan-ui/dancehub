/**
 * 单店/多店课表页（pages/studio/weekly）舞种筛选烟测。
 *
 * 小程序页面没法在 Node 里真跑，这里把 Page() 捕获下来，手动喂一周假课表，
 * 验证「舞种条统计 / 两级筛选 / 空态归因 / 换门店重算」四条逻辑。
 *
 * 关键手法：先用 require.cache 把 services/api.js 换成假实现，
 * 再 require 页面模块，页面里的 require("../../services/api") 就会命中假模块。
 *
 * 这里不调 onLoad（那要牵扯日期条、关注态、实时人数一整套），
 * 而是直接把 weeksCache / weekMonday 塞好，只测筛选这一层。
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");
global.wx = new Proxy(
  {
    getSystemInfoSync: () => ({ windowHeight: 667, safeArea: { bottom: 647 } }),
    navigateTo: ({ url }) => {
      global.__lastUrl = url;
    },
    showToast: ({ title }) => {
      global.__toast = title;
    },
    getStorageSync: () => "",
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({ globalData: {} });
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    ensureReady: async () => {},
    apiStudioSchedules: async () => [],
    apiMultiTimeline: async () => ({ items: [], studios: [] }),
  },
};

require(path.join(MINIAPP, "pages/studio/weekly.js"));
const { dateKey } = require(path.join(MINIAPP, "utils/date.js"));

function makePage() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) {
      if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
      page.data[k] = patch[k];
    }
  };
  // 实时回源人数跟筛选无关，且会打网络，直接掐掉
  page.refreshLiveNumbers = () => {};
  return page;
}

/** 塞一周课表（grouped），并把页面状态摆到「正在看这一天」 */
function seed(page, grouped, opts = {}) {
  const monday = new Date();
  const keys = Object.keys(grouped);
  page.multiMode = !!opts.multiMode;
  page.activeStyles = null;
  page.weeksCache = { [dateKey(monday)]: grouped };
  page.weekMonday = monday;
  page.bookedIds = new Set();
  page._shownBlocked = {};
  page.data.weekDays = keys.map((k) => ({ key: k, label: k, num: k }));
  page.data.selectedKey = opts.selectedKey || keys[0];
  return { keys, monday };
}

const item = (id, date, courseName, studioId) => ({
  id,
  scheduleDate: date,
  courseName,
  startTime: "10:00",
  coachName: "甲教练",
  studioId: studioId || null,
});

let failed = 0;
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${g}，期望 ${w}`}`);
}

(async () => {
  // ── 场景 1：单店，一周三种舞种 + 认不出来的课 ──
  const page = makePage();
  const d1 = "2026-09-28";
  const d2 = "2026-09-29";
  const week = {
    [d1]: [
      item(1, d1, "Jazz基础"),
      item(2, d1, "HIPHOP入门"),
      item(3, d1, "早功"), // 认不出舞种 → 其它
    ],
    [d2]: [item(4, d2, "Kpop女团"), item(5, d2, "古典舞身韵")],
  };
  seed(page, week);
  page.syncStyleChips(week);
  page.applyWeekData();

  check("舞种条显示", page.data.showStyleBar, true);
  // 课数都一样时按 DISPLAY_ORDER 排（Kpop/街舞在前，「其它」永远垫底）
  check(
    "舞种 chip（同课数按固定次序，其它垫底）",
    page.data.styleChips.map((c) => c.label),
    ["Kpop", "HipHop", "Jazz", "中国舞", "其它"],
  );
  check(
    "计数是整周的不是某一天的",
    page.data.styleChips.map((c) => c.count),
    [1, 1, 1, 1, 1],
  );
  check("首次默认全选", page.data.styleAllOn, true);
  check("当天课全在", page.data.dayItems.map((i) => i.id), [1, 2, 3]);

  // ── 场景 2：取消一个舞种 ──
  page.tapStyleChip({ currentTarget: { dataset: { label: "Jazz" } } });
  check("取消 Jazz 后当天只剩另两节", page.data.dayItems.map((i) => i.id), [2, 3]);
  check("chip 高亮跟着变", page.data.styleChips.find((c) => c.label === "Jazz").on, false);
  check("未全选", page.data.styleAllOn, false);

  // ── 场景 3：切到另一天，筛选态要保留（Kpop 那节还在）──
  page.data.selectedKey = d2;
  page.applyWeekData();
  check("换日期后筛选态保留", page.data.dayItems.map((i) => i.id), [4, 5]);

  // ── 场景 4：筛到只剩一个再取消 → 拦住 ──
  page.activeStyles = ["Kpop"];
  page.setData({ styleChips: page.data.styleChips.map((c) => ({ ...c, on: c.label === "Kpop" })) });
  page.tapStyleChip({ currentTarget: { dataset: { label: "Kpop" } } });
  check("最后一个舞种不许取消", global.__toast, "至少保留一个舞种");
  check("拦住后仍选中 Kpop", page.data.styleChips.find((c) => c.label === "Kpop").on, true);

  // ── 场景 5：「全部」一键恢复 ──
  page.tapAllStyles();
  check("全部恢复", page.data.styleAllOn, true);
  check("恢复后当天两节都在", page.data.dayItems.map((i) => i.id), [4, 5]);

  // ── 场景 6：空态归因 —— 这天本来有课，是被舞种筛掉的 ──
  page.activeStyles = ["Jazz"];
  page.setData({ styleChips: page.data.styleChips.map((c) => ({ ...c, on: c.label === "Jazz" })) });
  page.applyWeekData();
  check("Jazz 只筛出 Jazz 那节", page.data.dayItems.length, 0);
  check("空态归因为「舞种筛掉」而非「当天没课」", page.data.styleFilteredOut, true);

  // 换到有 Jazz 的那天 → 不该再提示被筛掉
  page.data.selectedKey = d1;
  page.applyWeekData();
  check("有 Jazz 的那天正常出课", page.data.dayItems.map((i) => i.id), [1]);
  check("那天不算被筛掉", page.data.styleFilteredOut, false);

  // ── 场景 7：整周只有一种舞种 → 没得选，不显示条 ──
  const page2 = makePage();
  const only = { [d1]: [item(11, d1, "Jazz基础"), item(12, d1, "JAZZ提高")] };
  seed(page2, only);
  page2.syncStyleChips(only);
  page2.applyWeekData();
  check("只有一种舞种时不显示筛选条", page2.data.showStyleBar, false);
  check("不显示时课照常出", page2.data.dayItems.map((i) => i.id), [11, 12]);

  // ── 场景 8：多店模式 —— 门店 × 舞种 两级，换门店要重算 ──
  const page3 = makePage();
  const week3 = {
    [d1]: [
      item(21, d1, "Jazz基础", 201),
      item(22, d1, "HIPHOP入门", 201),
      item(23, d1, "Kpop女团", 202),
    ],
  };
  seed(page3, week3, { multiMode: true });
  page3.data.stores = [
    { id: 201, short: "甲店", count: 2 },
    { id: 202, short: "乙店", count: 1 },
  ];
  page3.data.activeStoreIds = [201];
  page3.syncStyleChips(week3);
  page3.applyWeekData();
  check(
    "只勾甲店时只有它的两种舞种",
    page3.data.styleChips.map((c) => c.label).sort(),
    ["HipHop", "Jazz"],
  );

  // 勾上乙店 → Kpop 应该出现
  page3.data.activeStoreIds = [201, 202];
  page3.syncStyleChips(week3);
  page3.applyWeekData();
  check(
    "加勾乙店后 Kpop 出现",
    page3.data.styleChips.map((c) => c.label).sort(),
    ["HipHop", "Jazz", "Kpop"],
  );
  check("三家课都在", page3.data.dayItems.map((i) => i.id), [21, 22, 23]);

  // 只勾乙店 → 只剩 Kpop 一种，条要收起
  page3.data.activeStoreIds = [202];
  page3.syncStyleChips(week3);
  page3.applyWeekData();
  check("只勾乙店时只剩一种 → 条收起", page3.data.showStyleBar, false);
  check("乙店的课还在", page3.data.dayItems.map((i) => i.id), [23]);

  // ── 场景 9：取消过的舞种不能被「换门店」悄悄勾回来 ──
  const page4 = makePage();
  seed(page4, week3, { multiMode: true });
  page4.data.stores = [
    { id: 201, short: "甲店", count: 2 },
    { id: 202, short: "乙店", count: 1 },
  ];
  page4.data.activeStoreIds = [201];
  page4.syncStyleChips(week3); // 甲店：Jazz + HipHop
  page4.tapStyleChip({ currentTarget: { dataset: { label: "HipHop" } } }); // 主动取消 HipHop
  check("取消 HipHop 后只剩 Jazz 的课", page4.data.dayItems.map((i) => i.id), [21]);

  page4.data.activeStoreIds = [201, 202];
  page4.syncStyleChips(week3); // 乙店带来 Kpop（新），HipHop 是见过的旧舞种
  page4.applyWeekData();
  check(
    "新舞种自动补选、旧舞种的取消被保留",
    page4.data.styleChips.filter((c) => c.on).map((c) => c.label),
    ["Kpop", "Jazz"],
  );
  check("课跟着对上", page4.data.dayItems.map((i) => i.id), [21, 23]);

  console.log(failed === 0 ? "\n✔ 全部通过" : `\n✖ ${failed} 项失败`);
  process.exit(failed ? 1 : 0);
})();
