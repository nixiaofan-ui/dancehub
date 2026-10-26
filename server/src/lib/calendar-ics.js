/**
 * 手机日历订阅的 ICS 生成（纯函数，不碰数据库，方便单测）。
 *
 * 时区口径：库里存的都是中国用户的本地时间，和网页端 /lib/calendar.js 一样
 * 统一按 UTC+8 折算成 UTC 时间戳，避免各家日历 App 的时区解释差异。
 * 输入形态 = /auth/calendar-sync 存进 User.calReminders 的白名单镜像：
 *   { reminders: [{scheduleDate,startTime,endTime,courseName,coachName,studioName}],
 *     watches:   { [studioId]: {studioName, weekdays:[0-6], time:"HH:mm"} } }
 */

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function escapeText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** 本地(UTC+8)日期+时间 → UTC 时间戳字符串（YYYYMMDDTHHMM00Z） */
function utcStamp(dateKey, timeKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const [hour, minute] = String(timeKey).split(":").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
}

/** 下一个周几（不含今天；今天恰好是该周几就推 7 天后），返回 YYYY-MM-DD */
export function nextDateForWeekday(weekday) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diff = (weekday - base.getUTCDay() + 7) % 7 || 7;
  base.setUTCDate(base.getUTCDate() + diff);
  const pad = (n) => String(n).padStart(2, "0");
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

function courseEvent(reminder, dtstamp, seed) {
  const title = `${reminder.courseName} · ${reminder.studioName || "DanceHub"}`;
  return [
    "BEGIN:VEVENT",
    `UID:dancehub-course-${escapeText(reminder.scheduleDate)}-${escapeText(reminder.startTime)}-${seed}@dancehub`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${utcStamp(reminder.scheduleDate, reminder.startTime)}`,
    `DTEND:${utcStamp(reminder.scheduleDate, reminder.endTime || reminder.startTime)}`,
    `SUMMARY:${escapeText(title)}`,
    `DESCRIPTION:${escapeText(`老师：${reminder.coachName || "待定"}\\n地点：${reminder.studioName || "舞室"}\\n课程信息仅供参考，请以门店官方渠道为准。`)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT120M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(title)}`,
    "END:VALARM",
    "END:VEVENT",
  ];
}

function watchEvents(id, watch, dtstamp) {
  const name = watch.studioName || `舞室 #${id}`;
  const title = `${name} 放课提醒`;
  return watch.weekdays.map((weekday) => {
    const startDate = nextDateForWeekday(weekday);
    const start = utcStamp(startDate, watch.time);
    // 结束时间 = 开始 + 10 分钟（和网页端生成的事件保持一致）
    const endStamp = new Date(
      Date.parse(start.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})00Z$/, "$1-$2-$3T$4:$5:00Z")) +
        10 * 60 * 1000,
    );
    const pad = (n) => String(n).padStart(2, "0");
    const end = `${endStamp.getUTCFullYear()}${pad(endStamp.getUTCMonth() + 1)}${pad(endStamp.getUTCDate())}T${pad(endStamp.getUTCHours())}${pad(endStamp.getUTCMinutes())}00Z`;
    return [
      "BEGIN:VEVENT",
      `UID:dancehub-watch-${escapeText(id)}-${WEEKDAY_CODES[weekday]}@dancehub`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeText(title)}`,
      `DESCRIPTION:${escapeText(`查看 ${name} 是否更新排课。此事件每周重复写入你的日历。`)}`,
      "BEGIN:VALARM",
      "TRIGGER:PT0S",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(title)}`,
      "END:VALARM",
      `RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAY_CODES[weekday]}`,
      "END:VEVENT",
    ];
  });
}

/** 组装完整 ICS 文本；data 里缺 reminders/watches 也能出空日历（订阅不报错） */
export function buildCalendarIcs(data, now = new Date()) {
  const safe = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const dtstamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const seed = Math.random().toString(36).slice(2, 8);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DanceHub//Calendar Sync//ZH",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:DanceHub 提醒",
    ...(Array.isArray(safe.reminders)
      ? safe.reminders.flatMap((r, index) => courseEvent(r, dtstamp, `${seed}${index}`))
      : []),
    ...(safe.watches && typeof safe.watches === "object"
      ? Object.entries(safe.watches).flatMap(([id, w]) => watchEvents(id, w, dtstamp))
      : []),
    "END:VCALENDAR",
    "",
  ];
  return lines.join("\r\n");
}
