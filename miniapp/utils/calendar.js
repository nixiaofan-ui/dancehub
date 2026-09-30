/**
 * 手机系统日历（wx.addPhoneCalendar / wx.addPhoneRepeatCalendar）。
 *
 * 为什么要它：小程序订阅消息是**一次性**的 —— 用户授权一次只能推一条，
 * 「抢课」这种要反复蹲点的场景几次就把额度耗光；系统日历是手机自己的闹钟，
 * 不消耗任何额度、离线也会响，还能跟着 iCloud / 华为云同步到平板和电脑。
 *
 * ⛔ 时间戳一律用 `${dateKey}T${hhmm}:00+08:00` 构造：
 *   Schedule.scheduleDate 存的是 **UTC 午夜**、startTime 存的是**北京墙钟时刻**，
 *   直接 new Date("2026-10-05 19:00") 会按运行环境时区解析（云端 UTC / 手机 +08
 *   各得一个值，差 8 小时）。写死 +08:00 之后在哪儿跑都是同一个绝对时刻。
 *
 * ⚠ iOS 的坑：日历权限有两档，用户在「设置 → 微信 → 日历」里必须选**完全访问**；
 *   「仅添加事件」那一档调用**不报错也不写入**，前端无从判断 —— 所以这句提示
 *   必须提前写在界面上（见 CAL_HINT），不能等 fail 回调再说。
 */

const TZ = "+08:00";

/** 界面文案：权限的两档差异必须在用户点之前就讲清楚 */
const CAL_HINT = "iOS 请在「设置 → 微信 → 日历」选「完全访问」，只选「仅添加事件」不会写入";

/** "2026-10-05" + "19:00" → unix 秒（绝对时刻）；解析不了返回 0，由调用方拦 */
function toUnixSeconds(dateKey, hhmm) {
  const key = String(dateKey || "").trim();
  const hm = String(hhmm || "").slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !/^\d{2}:\d{2}$/.test(hm)) return 0;
  const t = Date.parse(key + "T" + hm + ":00" + TZ);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/** 低版本微信没有这个接口（基础库 2.15.0 起），要能优雅说"不支持"而不是白点一下 */
function supported() {
  return (
    typeof wx !== "undefined" &&
    typeof wx.addPhoneCalendar === "function" &&
    (typeof wx.canIUse !== "function" || wx.canIUse("addPhoneCalendar"))
  );
}

/**
 * 日历授权。
 * true = 可以继续调用；false = 用户明确拒过（已在设置页里引导过一次）。
 * undefined（从没问过）算 true —— 直接调用，微信自己会弹授权框。
 */
function ensureAuth() {
  return new Promise((resolve) => {
    if (typeof wx.getSetting !== "function") return resolve(true);
    wx.getSetting({
      success(res) {
        const v = (res && res.authSetting && res.authSetting["scope.addPhoneCalendar"]) || undefined;
        if (v !== false) return resolve(true);
        // ⚠ 拒过之后不会再有弹窗，只能带用户去设置页手动打开
        wx.showModal({
          title: "需要日历权限",
          content: "闹钟要写进手机日历，才能在没有网络的时候也响。请在设置里允许「添加到日历」。",
          confirmText: "去设置",
          success(r) {
            if (r && r.confirm && wx.openSetting) {
              wx.openSetting({ complete: () => resolve(false) });
            } else {
              resolve(false);
            }
          },
          fail() {
            resolve(false);
          },
        });
      },
      fail() {
        resolve(true);
      },
    });
  });
}

function buildTitle(courseName, studioName) {
  // 日历列表只显示标题，不写店名的话一周下来分不清是哪家舞室的课
  const name = String(courseName || "舞蹈课").trim();
  const studio = String(studioName || "").trim();
  return studio ? name + " · " + studio : name;
}

function buildDesc(course) {
  const bits = [];
  if (course.studioName) bits.push("舞室：" + course.studioName);
  if (course.coachName) bits.push("老师：" + course.coachName);
  if (course.roomName) bits.push("教室：" + course.roomName);
  bits.push("课程由 DanceHub 加入");
  return bits.join("\n");
}

/** 实际落盘：一次 addPhoneCalendar 调用 */
function writeEvent(opt) {
  if (!supported()) {
    return Promise.reject(new Error("当前微信版本不支持写日历，升级微信后再试"));
  }
  return ensureAuth().then((allowed) => {
    if (!allowed) return { added: false, denied: true };
    return new Promise((resolve, reject) => {
      wx.addPhoneCalendar({
        title: opt.title,
        startTime: opt.startTime,
        // 上游偶尔给不出下课时间：给个 1 小时默认时长，别传 0（会被当成同一时刻）
        endTime: opt.endTime > opt.startTime ? opt.endTime : opt.startTime + 3600,
        allDay: false,
        location: opt.location || "",
        description: opt.description || "",
        alarm: true,
        alarmOffset: opt.alarmOffset || 0,
        success: () => resolve({ added: true }),
        fail: (err) => {
          const msg = String((err && err.errMsg) || "");
          // 拒过授权 / 系统层拒绝：算"没加成"，不算异常
          if (msg.indexOf("deny") >= 0 || msg.indexOf("authoriz") >= 0) {
            return resolve({ added: false, denied: true });
          }
          reject(new Error("写日历失败：" + (msg || "未知原因")));
        },
      });
    });
  });
}

/**
 * 把一节课写进手机日历（提前 1 小时响 —— 留出「去不去 / 要不要取消」的时间）。
 * course: { dateKey, startTime, endTime, courseName, studioName, coachName, roomName, address }
 */
function addCourseToCalendar(course) {
  const c = course || {};
  const startTime = toUnixSeconds(c.dateKey, c.startTime);
  if (!startTime) return Promise.reject(new Error("这节课的时间不完整，加不了日历"));
  return writeEvent({
    title: buildTitle(c.courseName, c.studioName),
    startTime,
    endTime: toUnixSeconds(c.dateKey, c.endTime),
    location: c.address || c.studioName || "",
    description: buildDesc(c),
    alarmOffset: 3600,
  });
}

/**
 * 每周重复的约课提醒（「这家店每周三中午放课」这种）。
 * weekday 0=周日 … 6=周六；hhmm 是本机时区的墙钟时刻（用户手机就是北京时间）。
 * repeatInterval 只支持 day/week/month/year；month 那档日期不能大于 28 日，别用。
 */
function addWeeklyWatchToCalendar(opt) {
  const o = opt || {};
  if (!supported() || typeof wx.addPhoneRepeatCalendar !== "function") {
    return Promise.reject(new Error("当前微信版本不支持重复日历事件，升级微信后再试"));
  }
  const hm = String(o.hhmm || "12:00").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(hm)) return Promise.reject(new Error("提醒时刻不完整，加不了日历"));

  // 从今天起找下一个目标星期几；今天就是这个星期几、时刻还没过就算今天
  const now = new Date();
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  day.setDate(day.getDate() + ((Number(o.weekday) - day.getDay() + 7) % 7));
  const dateKey = day.getFullYear() + "-" + pad(day.getMonth() + 1) + "-" + pad(day.getDate());
  let startTime = toUnixSeconds(dateKey, hm);
  if (!startTime) return Promise.reject(new Error("提醒时刻不完整，加不了日历"));
  if (startTime * 1000 <= Date.now()) startTime += 7 * 86400;

  return ensureAuth().then((allowed) => {
    if (!allowed) return { added: false, denied: true };
    return new Promise((resolve, reject) => {
      // ⚠ 重复事件没有 alarmOffset 的兜底路径：这里同样只提前 0 分钟响
      wx.addPhoneRepeatCalendar({
        title: o.title || "去约课",
        startTime,
        endTime: startTime + 600,
        allDay: false,
        description: o.desc || "DanceHub 每周提醒你：这家店该放课了",
        alarm: true,
        repeatInterval: "week",
        success: () => resolve({ added: true }),
        fail: (err) => {
          const msg = String((err && err.errMsg) || "");
          if (msg.indexOf("deny") >= 0 || msg.indexOf("authoriz") >= 0) {
            return resolve({ added: false, denied: true });
          }
          reject(new Error("写日历失败：" + (msg || "未知原因")));
        },
      });
    });
  });
}

module.exports = {
  CAL_HINT,
  supported,
  toUnixSeconds,
  addCourseToCalendar,
  addWeeklyWatchToCalendar,
};
