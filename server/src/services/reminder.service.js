import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { sendSubscribeMessage } from "./wechat.service.js";
import { toDateKey } from "./schedule.service.js";

export function subscribeConfigured() {
  return Boolean(
    config.wechat.appId && config.wechat.appSecret && config.wechat.classReminderTplId,
  );
}

/**
 * 把用户说的「2026-10-05 12:00」按**北京时间**解析成 Date。
 *
 * ⚠ 不能直接 new Date(text)：容器按 UTC 跑，那样得到的是 UTC 的 12:00，
 *   落到用户手机上是晚上 8 点 —— 抢课闹钟差这 8 小时等于白设。
 *   挂上 +08:00 把时区写死，容器时区怎么变都不受影响。
 * 返回 null 表示格式不对，交给调用方报错（比默默存个 Invalid Date 强）。
 */
export function parseUserDateTime(text) {
  const m = String(text || "")
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT]+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const d = new Date(`${p(m[1], 4)}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${p(m[5])}:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Date → 东八区的 "2026-10-05 12:00"。
 * 给前端直接用，省得它在小程序里再转一次时区（容器是 UTC，直接 toISOString 会差 8 小时）。
 */
export function toLocalText(date) {
  return new Date(date).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16);
}

/**
 * 提醒场景。抢课闹钟与开课提醒的差别不在"提前多久"，而在"谁定的时刻"：
 * 放课时刻各家舞室都不一样、也没有任何平台接口给这个值，只能让用户自己填。
 */
export const REMIND_KINDS = ["CLASS", "SNIPE"];

/** 抢课闹钟的作废窗口：晚于预定时刻这么久就别发了（详见 sendDueReminders） */
export const SNIPE_EXPIRE_MS = 2 * 60 * 60 * 1000;

/** 开课提醒提前量：课前 2 小时。 */
export const REMIND_LEAD_MS = 2 * 60 * 60 * 1000;

/**
 * 由课程算出提醒时间。
 *
 * 抽出来是因为手动开提醒（POST /reminders）和补录时自动开提醒（「想上」）
 * 是两处独立的调用点 —— 各算一遍的话，哪天改提前量就会只改一处，
 * 结果自动设的提醒和手动设的差两小时，还没人能解释为什么。
 *
 * ⚠ 别顺手把这行「修」成 UTC 口径（直接拿 scheduleDate 的 getTime 加毫秒）。
 *   scheduleDate 存的是 UTC 午夜，单纯加毫秒得到的是 UTC 的 HH:mm；
 *   而这里 setHours 是本地时区口径，两者在东八区相差整 8 小时 ——
 *   改了之后所有已有提醒会集体偏移，且和用户看到的课程时间对不上。
 */
export function computeRemindAt(schedule) {
  const scheduleAt = new Date(schedule.scheduleDate);
  const [h, m] = schedule.startTime.toTimeString().slice(0, 5).split(":").map(Number);
  scheduleAt.setHours(h, m, 0, 0);
  return new Date(scheduleAt.getTime() - REMIND_LEAD_MS);
}

/**
 * 微信订阅消息的字段长度按「字符数」算：一个汉字算 2，ASCII 算 1，上限 20。
 * 直接 slice(0, 20) 会把 20 个汉字算成 40 字符而超长被拒（errcode 47003）。
 */
export function fitText(input, fallback) {
  const src = String(input || "").trim();
  if (!src) return fallback;
  let weight = 0;
  let out = "";
  for (const ch of src) {
    // 码点 >= 0x1100 基本就是中日韩文字与全角符号，微信按 2 个字符算。
    // 只按汉字区间写正则会漏掉韩文（舞室名很常见）和日文假名。
    const w = ch.codePointAt(0) >= 0x1100 ? 2 : 1;
    if (weight + w > 20) break;
    weight += w;
    out += ch;
  }
  return out || fallback;
}

/**
 * 字段编号必须跟小程序后台那个模板的「模板详情」一一对应，错一个都会 47003。
 * 当前模板：name1 课程名称 / time2 课程时间 / thing3 上课地点 / thing8 授课老师
 * 换模板时只要改这里的键名，不要改别处。
 */
export function buildClassReminderData(r) {
  const d = new Date(r.schedule.scheduleDate);
  const hhmm = r.schedule.startTime.toTimeString().slice(0, 5);
  // time 类型要用「YYYY年M月D日 HH:MM」格式，"2026-09-27 19:00" 有被拒的风险
  const time = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  return {
    name1: { value: fitText(r.schedule.courseName, "课程") },
    time2: { value: time },
    thing3: { value: fitText(r.schedule.studio?.name, "舞室") },
    thing8: { value: fitText(r.schedule.coach?.name, "待定") },
  };
}

export async function sendDueReminders() {
  const now = new Date();

  const due = await prisma.reminder.findMany({
    where: {
      status: "PENDING",
      subscribeTplId: { not: null },
      remindAt: { lte: now },
    },
    include: {
      user: true,
      schedule: { include: { studio: true, coach: true } },
    },
    orderBy: { remindAt: "asc" },
    take: 50,
  });

  let sent = 0;
  let skipped = 0;
  for (const r of due) {
    // 抢课闹钟讲究的是准时：放名额那一刻过了，再收到「去抢」就是废通知，
    // 甚至会让用户以为是我们推送不可靠。晚于预定时刻 2 小时的直接作废。
    if (r.kind === "SNIPE" && now - new Date(r.remindAt) > SNIPE_EXPIRE_MS) {
      await prisma.reminder.update({
        where: { id: r.id },
        data: { status: "CANCELLED" },
      });
      skipped += 1;
      continue;
    }
    try {
      if (r.user.openid.startsWith("dev:")) {
        // 开发模式：未接入真实 appid，模拟发送
        console.log(
          `[dancehub] [mock subscribe] -> ${r.user.openid} | ${r.schedule.courseName} @ ${r.schedule.studio.name}`,
        );
      } else {
        await sendSubscribeMessage({
          openid: r.user.openid,
          templateId: r.subscribeTplId,
          // 直达这节课而不是首页：抢课场景下多一次点击就可能没了位置
          page: `pages/course/detail?id=${r.schedule.id}`,
          data: buildClassReminderData(r),
        });
      }
      await prisma.reminder.update({
        where: { id: r.id },
        data: { status: "SENT", sentAt: new Date() },
      });
      sent += 1;
    } catch (e) {
      console.warn(`[dancehub] reminder#${r.id} send failed: ${e.message}`);
      // 43101 = 用户取消授权/授权失效，不再重试
      if (String(e.message).includes("43101")) {
        await prisma.reminder.update({
          where: { id: r.id },
          data: { status: "CANCELLED" },
        });
      }
    }
  }

  return { due: due.length, sent, skipped };
}