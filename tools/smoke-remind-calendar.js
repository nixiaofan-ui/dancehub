/**
 * 「约课提醒 + 手机日历」烟测。
 *
 * 盯四件事（都是"错了也不报错、只是默默不对"的那种）：
 *   1. 时区：课程时间 → unix 秒必须是**绝对时刻**，换个 TZ 跑结果要一样。
 *      本项目 scheduleDate 存 UTC 午夜、startTime 存北京墙钟，拼错一次差 8 小时，
 *      日历里的事件就跑到半夜去了，而且没有任何报错。
 *   2. 写日历的入参：标题要带店名、提前 1 小时响、endTime 缺失时给默认时长。
 *   3. 约课提醒落日历：开关打开才写，且**日历失败不能把提醒一起废掉**
 *      （订阅消息一次性消耗，日历才是蹲点最靠得住的那条通道）。
 *   4. 已约课程加日历：数据取自当前渲染的详情，不是别处。
 *
 *   /usr/local/bin/node tools/smoke-remind-calendar.js
 */
const path = require("path");
const { execFileSync } = require("child_process");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

/* ── wx mock：把写日历的入参抓下来 ── */
const calls = { calendar: [], repeat: [], toast: [] };
global.wx = new Proxy(
  {
    canIUse: () => true,
    getSetting: ({ success }) => success({ authSetting: { "scope.addPhoneCalendar": true } }),
    showModal: () => {},
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
global.getApp = () => ({ globalData: { cityId: 1, token: "t", classReminderTplId: "" } });
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

const cal = require(path.join(MINIAPP, "utils/calendar.js"));

/* ── 详情页 mock：一节 10-05 19:00-20:00 的课 ── */
const DETAIL = {
  id: 77,
  courseName: "Jazz 编舞",
  difficulty: "ALL_LEVELS",
  scheduleDate: "2026-10-05",
  startTime: "19:00",
  endTime: "20:00",
  bookingStatus: "CONFIRMED",
  reminded: false,
  snipeRemindAt: null,
  bookedCount: 0,
  bookedNum: 12,
  capacity: 30,
  bookedAt: "2026-09-30T03:00:00Z",
  remark: null,
  hasVideo: false,
  coach: { id: 3, name: "Ken", avatarUrl: "" },
  studio: {
    id: 5,
    name: "MAX POWER STUDIO（陆家嘴店）",
    address: "上海市浦东新区世纪大道 1 号",
    platform: "IWOD",
    cityId: 1,
  },
};

let addReminderArgs = null;
const fakeApi = {
  ensureReady: async () => {},
  apiScheduleDetail: async () => JSON.parse(JSON.stringify(DETAIL)),
  apiScheduleVideoPreview: async () => ({ items: [] }),
  apiScheduleVideoUrl: async () => ({ url: "" }),
  apiLiveBooking: async () => ({ bookedNum: 12, capacity: 30, live: true }),
  apiAddReminder: async (id, sub, opts) => {
    addReminderArgs = { id, sub, opts };
    return {};
  },
  apiRemoveReminder: async () => ({}),
  apiCancelBooking: async () => ({}),
};
const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/course/detail.js"));

function makePage(withDetail) {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) {
      if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
      page.data[k] = patch[k];
    }
  };
  page.scheduleId = 77;
  if (withDetail) page.data.detail = JSON.parse(JSON.stringify(DETAIL));
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
  // ── 1. 时区：绝对时刻，跟运行环境无关 ──
  const want = Math.floor(Date.parse("2026-10-05T19:00:00+08:00") / 1000);
  check("北京 19:00 → unix 秒", cal.toUnixSeconds("2026-10-05", "19:00"), want);
  check("非法输入返回 0（不编时间）", [
    cal.toUnixSeconds("", "19:00"),
    cal.toUnixSeconds("2026-10-05", ""),
    cal.toUnixSeconds("2026/10/05", "19:00"),
  ], [0, 0, 0]);

  // 换个时区跑同一段代码，结果必须一模一样（这是"拼 +08:00"唯一的意义）
  const probe = `const c=require(${JSON.stringify(path.join(MINIAPP, "utils/calendar.js"))});` +
    `process.stdout.write(String(c.toUnixSeconds("2026-10-05","19:00")))`;
  const otherTz = execFileSync(process.execPath, ["-e", probe], {
    env: { ...process.env, TZ: "America/New_York" },
  }).toString();
  check("TZ=America/New_York 下结果相同", otherTz, String(want));

  // ── 2. 写日历的入参 ──
  calls.calendar.length = 0;
  await cal.addCourseToCalendar({
    dateKey: "2026-10-05", startTime: "19:00", endTime: "20:00",
    courseName: "Jazz 编舞", studioName: "MAX POWER STUDIO（陆家嘴店）",
    coachName: "Ken", roomName: "1F", address: "上海市浦东新区世纪大道 1 号",
  });
  const ev = calls.calendar[0];
  check("标题带店名（日历列表只显示标题）", ev.title, "Jazz 编舞 · MAX POWER STUDIO（陆家嘴店）");
  check("开始时间", ev.startTime, want);
  check("结束时间", ev.endTime, want + 3600);
  check("提前 1 小时响", ev.alarmOffset, 3600);
  check("地点用门店地址", ev.location, "上海市浦东新区世纪大道 1 号");
  check("说明里有老师和教室", /老师：Ken/.test(ev.description) && /教室：1F/.test(ev.description), true);

  calls.calendar.length = 0;
  await cal.addCourseToCalendar({ dateKey: "2026-10-05", startTime: "19:00", courseName: "X" });
  check("没给下课时间 → 默认 1 小时", calls.calendar[0].endTime - calls.calendar[0].startTime, 3600);

  // ⚠ 时间不全必须 reject，不能默默写一个 1970 年的日程进去
  let rejected = "";
  await cal.addCourseToCalendar({ dateKey: "", startTime: "", courseName: "X" }).catch((e) => {
    rejected = e.message;
  });
  check("时间不全 → 明确报错", rejected.includes("加不了日历"), true);

  // ── 3. 约课提醒（一次性闹钟） ──
  calls.calendar.length = 0;
  await cal.addWatchToCalendar({ dateKey: "2026-10-02", hhmm: "12:00", title: "去约课：Jazz 编舞" });
  check("约课提醒提前 0 分钟响（踩点）", calls.calendar[0].alarmOffset, 0);
  check("约课提醒时刻", calls.calendar[0].startTime, Math.floor(Date.parse("2026-10-02T12:00:00+08:00") / 1000));

  // ── 4. 详情页：设约课提醒（开日历同步） ──
  const page = makePage(false);
  await page.load();
  check("详情加载出课程", page.data.detail.courseName, "Jazz 编舞");
  check("默认勾选写日历", page.data.snipeSyncCal, true);
  check("没设提醒时的按钮文案", page.data.snipeLabel, "设约课提醒");

  page.openSnipe();
  check("弹层打开", page.data.snipeOpen, true);
  check("日期默认今天", page.data.snipeDate, page.data.todayKey);
  page.onSnipeDate({ detail: { value: "2026-10-02" } });
  page.onSnipeTime({ detail: { value: "12:00" } });

  calls.calendar.length = 0;
  addReminderArgs = null;
  await page.saveSnipe();
  check("提醒接口收到 SNIPE + 时刻", addReminderArgs.opts, { kind: "SNIPE", remindAt: "2026-10-02 12:00" });
  check("同时写了一份进日历", calls.calendar.length, 1);
  check("日历事件标题带课名", calls.calendar[0].title, "去约课：Jazz 编舞");
  check("弹层关闭", page.data.snipeOpen, false);

  // ── 5. 日历失败不能把提醒一起废掉 ──
  const origin = wx.addPhoneCalendar;
  Object.defineProperty(global.wx, "addPhoneCalendar", {
    value: (o) => o.fail && o.fail({ errMsg: "addPhoneCalendar:fail system error" }),
    configurable: true,
  });
  const page2 = makePage(false);
  await page2.load();
  await page2.openSnipe();
  page2.onSnipeDate({ detail: { value: "2026-10-02" } });
  addReminderArgs = null;
  await page2.saveSnipe();
  check("日历炸了，提醒照样设上了", addReminderArgs !== null, true);
  check("并且如实告诉用户日历没加成", calls.toast.some((t) => /日历没加成/.test(t || "")), true);
  Object.defineProperty(global.wx, "addPhoneCalendar", { value: origin, configurable: true });

  // ── 6. 已约课程加进日历（按钮） ──
  calls.calendar.length = 0;
  const page3 = makePage(true);
  await page3.addToCalendar();
  const ev3 = calls.calendar[0];
  check("取的是当前这节详情的时间", [ev3.startTime, ev3.endTime], [want, want + 3600]);
  check("地点带上门店地址", ev3.location, "上海市浦东新区世纪大道 1 号");

  // ── 7. 每周重复的约课提醒 ──
  calls.repeat.length = 0;
  await cal.addWeeklyWatchToCalendar({ weekday: 3, hhmm: "12:00", title: "去约课" });
  const wk = calls.repeat[0];
  check("重复周期是每周", wk.repeatInterval, "week");
  const d = new Date(wk.startTime * 1000 + 8 * 3600 * 1000);
  check("落在周三（UTC+8 口径）", d.getUTCDay(), 3);
  check("一定是未来时刻", wk.startTime * 1000 > Date.now(), true);

  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
})();
