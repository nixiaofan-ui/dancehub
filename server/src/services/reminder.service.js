import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { sendSubscribeMessage } from "./wechat.service.js";
import { toDateKey } from "./schedule.service.js";

export function subscribeConfigured() {
  return Boolean(
    config.wechat.appId && config.wechat.appSecret && config.wechat.classReminderTplId,
  );
}

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
  for (const r of due) {
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
          page: "pages/index/index",
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

  return { due: due.length, sent };
}