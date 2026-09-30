/**
 * 教练主页（pages/coach/index）烟测。
 *
 * 这张页是「点教练卡片之后」的落地页，它必须回答两件事：
 *   1. 这老师接下来哪天、在哪家店有课（能约的）
 *   2. 他过去一周固定周几在哪上课（规律）
 * 门店条上的「哪家店什么时候有课」原本挤在发现页卡片上，现在搬到这儿。
 *
 * 另外盯一条曾把整页变白的写法：`await api.ensureReady()` 写在 try 外面，
 * 登录一旦失败 load 直接中断、loading 永远停在 true，用户看到的是
 * 「正在整理这位老师的课…」转到天荒地老，两块内容都不出现。
 *
 *   /usr/local/bin/node tools/smoke-coach-page.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

global.wx = new Proxy(
  {
    getStorageSync: () => "",
    setStorageSync: () => {},
    navigateTo: ({ url }) => (global.__lastUrl = url),
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({ globalData: { cityId: 1, token: "t" } });
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

const ST = (id, name, short) => ({ id, name, short, cityId: 1 });

/** 过去一周：同一家店两节（周日、周一） */
const PAST = {
  name: "雪霏",
  cityId: 1,
  direction: "past",
  from: "2026-09-23",
  to: "2026-09-29",
  studios: [{ ...ST(7, "RB Dance Studio（普陀）", "RB Dance…"), count: 2, firstDate: "2026-09-27" }],
  items: [
    { id: 1, courseName: "Jazz基础", scheduleDate: "2026-09-27", startTime: "13:00", endTime: "14:00", studio: ST(7, "RB Dance Studio（普陀）", "RB Dance…"), coach: { name: "雪霏" }, difficulty: "ALL_LEVELS", bookingStatus: null },
    { id: 2, courseName: "Hiphop入门", scheduleDate: "2026-09-28", startTime: "18:30", endTime: "19:30", studio: ST(7, "RB Dance Studio（普陀）", "RB Dance…"), coach: { name: "雪霏" }, difficulty: "BASIC", bookingStatus: null },
  ],
};

/** 未来两周：今天在陆家嘴两节，10-11 在杭州一家新店 */
const FUTURE = {
  name: "雪霏",
  cityId: 1,
  direction: "future",
  from: "2026-09-30",
  to: "2026-10-13",
  studios: [
    { ...ST(5, "MAX POWER STUDIO（陆家嘴店）", "陆家嘴店"), count: 2, firstDate: "2026-09-30", today: true },
    { ...ST(9, "SIX DANCE", "SIX DANCE"), count: 1, firstDate: "2026-10-11", today: false },
  ],
  items: [
    { id: 3, courseName: "Kpop女团", scheduleDate: "2026-09-30", startTime: "18:05", endTime: "19:05", studio: ST(5, "MAX POWER STUDIO（陆家嘴店）", "陆家嘴店"), coach: { name: "雪霏" }, difficulty: "ALL_LEVELS", bookingStatus: null },
    { id: 4, courseName: "Jazz编舞", scheduleDate: "2026-09-30", startTime: "19:15", endTime: "20:15", studio: ST(5, "MAX POWER STUDIO（陆家嘴店）", "陆家嘴店"), coach: { name: "雪霏" }, difficulty: "ALL_LEVELS", bookingStatus: "CONFIRMED" },
    { id: 5, courseName: "Waacking", scheduleDate: "2026-10-11", startTime: "15:00", endTime: "16:00", studio: ST(9, "SIX DANCE", "SIX DANCE"), coach: { name: "雪霏" }, difficulty: "ALL_LEVELS", bookingStatus: null },
  ],
};

let mode = "ok";
const fakeApi = {
  ensureReady: async () => {
    if (mode === "readyFail") throw new Error("登录失败");
  },
  apiCoachTimeline: async (name, cityId, days, dir) => {
    if (mode === "apiFail") throw new Error("连不上服务");
    return dir === "past" ? PAST : FUTURE;
  },
  apiFavCoaches: async () => [],
  apiBlocked: async () => [],
};

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/coach/index.js"));

function makePage() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) {
      if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
      page.data[k] = patch[k];
    }
  };
  page.onLoad({ name: encodeURIComponent("雪霏"), cityId: "1" });
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

(async () => {
  const page = makePage();
  await page.load();

  check("页面标题拿到的是解码后的名字", page.data.name, "雪霏");
  check("加载完成", page.data.loading, false);
  check("没有错误", page.data.loadError, "");

  // ── 过去一周：按周几归并成「排课规律」 ──
  // 周一在周日前面：一周从周一开始排（09-28 周一 18:30 / 09-27 周日 13:00）
  check("过去一周归并成两天", page.data.weekdays.map((w) => w.weekday), ["周一", "周日"]);
  check("每天几节", page.data.weekdays.map((w) => w.count), [1, 1]);
  check("同一天内按时间排", page.data.weekdays[0].items.map((i) => i.startTime), ["18:30"]);
  check("过去一周总课数", page.data.pastTotal, 2);

  // ── 未来：按日期分小节，能约的课要出来 ──
  check("未来拆成两个日期", page.data.days.map((d) => d.key), ["2026-09-30", "2026-10-11"]);
  check("今天那节标成「今天」", page.data.days[0].label.startsWith("今天"), true);
  check("未来总课数", page.data.total, 3);
  check("已约的课带出状态", page.data.days[0].items.map((i) => i.bookingStatus), [null, "CONFIRMED"]);

  // ── 门店条：哪家店、什么时候有课（原来挤在发现页卡片上的信息） ──
  check(
    "门店条：有未来课的在前，带日期",
    page.data.studios.map((s) => `${s.short}|${s.badge}`),
    ["陆家嘴店|今天有课", "SIX DANCE|10-11 有课", "RB Dance…|上周 2 节"],
  );
  check("只有今天的店标 hot", page.data.studios.map((s) => s.hot), [true, false, false]);

  // ── 接口失败：把错误留在页面上，不能只留一片白 ──
  mode = "apiFail";
  const page2 = makePage();
  await page2.load();
  check("接口失败 → loading 收起", page2.data.loading, false);
  check("接口失败 → 错误写在页面上", page2.data.loadError, "连不上服务");
  check("接口失败 → 不残留旧列表", page2.data.days.length, 0);

  // ── 登录失败：曾经因为 ensureReady 写在 try 外面，页面永远转圈 ──
  mode = "readyFail";
  const page3 = makePage();
  await page3.load();
  check("登录失败也不能卡在 loading", page3.data.loading, false);
  check("登录失败要给出原因", page3.data.loadError, "登录失败");

  console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
  process.exit(failed ? 1 : 0);
})();
