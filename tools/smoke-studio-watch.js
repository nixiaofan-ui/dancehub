/**
 * 门店「放课提醒」烟测（pages/studio/weekly）。
 *
 * 这是门店粒度的周期提醒：「每周三 12:00 提醒我去约课」。
 * 盯五件事：
 *   1. 设过要能回填原值（让人改时间，不是从头再选）
 *   2. 保存时把 weekday/hhmm 正确传给接口，并写一条每周重复的手机日历事件
 *   3. **日历失败不能连提醒一起废掉**（服务端那行只是"记着"，日历才是每周都会响的通道）
 *   4. 关掉之后状态要清掉，并且**如实告诉用户手机日历那条删不掉**
 *      —— 微信没有删日历的接口，不说明白用户下周被响一次会以为我们没关干净
 *   5. 星期下标 > 0 的映射：0=周日，别把「周三」存成数组下标 3 却显示成周四
 *
 *   /usr/local/bin/node tools/smoke-studio-watch.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

const calls = { calendar: [], repeat: [], toast: [], modal: [] };
global.wx = new Proxy(
  {
    canIUse: () => true,
    getSetting: ({ success }) => success({ authSetting: { "scope.addPhoneCalendar": true } }),
    showModal: (o) => calls.modal.push(o && o.content),
    openSetting: () => {},
    showToast: (o) => calls.toast.push(o && o.title),
    addPhoneCalendar: (o) => {
      calls.calendar.push(o);
      if (o.success) o.success({});
    },
    addPhoneRepeatCalendar: (o) => {
      calls.repeat.push(o);
      if (o.success) o.success({});
    },
    getStorageSync: () => "",
    setStorageSync: () => {},
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

let added = null;
let removed = null;
let studioWatch = null;
const fakeApi = {
  ensureReady: async () => {},
  apiStudioDetail: async () => ({ id: 5, name: "MAX POWER STUDIO（陆家嘴店）", platform: "IWOD" }),
  apiFollows: async () => [],
  apiStudioWatch: async () => studioWatch,
  apiAddStudioWatch: async (studioId, weekday, hhmm) => {
    added = { studioId, weekday, hhmm };
    return { weekday, hhmm, weekdayLabel: "" };
  },
  apiRemoveStudioWatch: async (studioId) => {
    removed = studioId;
    return { removed: 1 };
  },
  apiBookings: async () => [],
  apiWeekly: async () => ({ days: [] }),
};
const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/studio/weekly.js"));

function makePage() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) {
      if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
      page.data[k] = patch[k];
    }
  };
  page.studioId = 5;
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
  // ── 没设过：默认周三 12:00 ──
  const p1 = makePage();
  await p1.loadStudio(); // 真实路径：门店信息先到位（日历事件标题要用店名）
  check("初始没有提醒", p1.data.watch, null);
  check("星期下拉是 7 项且 0 是周日", p1.data.weekdayRange, ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);
  p1.openWatch();
  check("默认星期下标 3（周三）", p1.data.watchWeekday, 3);
  check("默认时刻 12:00", p1.data.watchTime, "12:00");
  check("默认勾选写日历", p1.data.watchSyncCal, true);
  check("标签与下标一致（0=周日）", p1.data.watchWeekdayLabel, "周三");

  // 切到周日 —— 下标 0 是最容易和"空值"混淆的那一档
  p1.onWatchWeekday({ detail: { value: "0" } });
  check("选周日下标为 0", p1.data.watchWeekday, 0);
  check("周日标签正确", p1.data.watchWeekdayLabel, "周日");
  p1.onWatchWeekday({ detail: { value: "3" } });
  p1.onWatchTime({ detail: { value: "11:30" } });

  calls.repeat.length = 0;
  added = null;
  await p1.saveWatch();
  check("接口收到 weekday", added, { studioId: 5, weekday: 3, hhmm: "11:30" });
  check("写了一条每周重复的日历事件", calls.repeat.length, 1);
  check("重复周期是每周", calls.repeat[0].repeatInterval, "week");
  check("标题带店名", calls.repeat[0].title, "去约课：MAX POWER STUDIO（陆家嘴店）");
  check("落点在未来（过去时刻等于不会响）", calls.repeat[0].startTime * 1000 > Date.now(), true);
  const at = new Date(calls.repeat[0].startTime * 1000 + 8 * 3600 * 1000);
  check("落在周三（东八区口径）", at.getUTCDay(), 3);
  check("落在 11:30", [at.getUTCHours(), at.getUTCMinutes()], [11, 30]);
  check("保存后页面状态记上", {
    weekday: p1.data.watch.weekday,
    hhmm: p1.data.watch.hhmm,
    label: p1.data.watch.weekdayLabel,
  }, { weekday: 3, hhmm: "11:30", label: "周三" });
  check("弹层关闭", p1.data.watchOpen, false);

  // ── 门店信息还没到位就设提醒：标题退化成「舞室」，但不能崩、不能写空标题 ──
  const p1b = makePage();
  calls.repeat.length = 0;
  await p1b.saveWatch();
  check("拿不到店名时用「舞室」兜底", calls.repeat[0].title, "去约课：舞室");

  // ── 设过之后再打开：回填原值 ──
  const p2 = makePage();
  studioWatch = { weekday: 5, hhmm: "09:00", weekdayLabel: "周五" };
  await p2.loadStudio();
  check("拉到了已设的提醒", p2.data.watch, { weekday: 5, hhmm: "09:00", weekdayLabel: "周五" });
  p2.openWatch();
  check("回填星期", [p2.data.watchWeekday, p2.data.watchWeekdayLabel], [5, "周五"]);
  check("回填时刻", p2.data.watchTime, "09:00");
  studioWatch = null;

  // ── 日历炸了，提醒照样要设上 ──
  const origin = wx.addPhoneRepeatCalendar;
  Object.defineProperty(global.wx, "addPhoneRepeatCalendar", {
    value: (o) => o.fail && o.fail({ errMsg: "addPhoneRepeatCalendar:fail auth deny" }),
    configurable: true,
  });
  const p3 = makePage();
  calls.toast.length = 0;
  added = null;
  await p3.saveWatch();
  check("日历没加成，提醒仍然设上了", added !== null, true);
  check("并且如实说明只剩小程序里记着", calls.toast.some((t) => /日历没加成/.test(t || "")), true);
  Object.defineProperty(global.wx, "addPhoneRepeatCalendar", { value: origin, configurable: true });

  // ── 关掉 ──
  const p4 = makePage();
  p4.data.watch = { weekday: 3, hhmm: "12:00", weekdayLabel: "周三" };
  calls.toast.length = 0;
  removed = null;
  await p4.removeWatch();
  check("接口收到 studioId", removed, 5);
  check("状态清掉", p4.data.watch, null);
  check("⚠ 必须提醒用户日历那条删不掉", calls.toast.some((t) => /自己删/.test(t || "")), true);

  // ── 关掉是幂等的（本来就没有也不报错）──
  const p5 = makePage();
  await p5.removeWatch();
  check("没有提醒时关掉不报错", p5.data.watch, null);

  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
})();
