import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { sendSubscribeMessage } from "./wechat.service.js";
import { toDateKey } from "./schedule.service.js";

export function subscribeConfigured() {
  return Boolean(config.wechat.appId && config.wechat.appSecret);
}

export function buildClassReminderData(r) {
  const time =
    toDateKey(r.schedule.scheduleDate) +
    " " +
    r.schedule.startTime.toTimeString().slice(0, 5);
  return {
    thing1: { value: (r.schedule.courseName || "课程").slice(0, 20) },
    thing2: { value: (r.schedule.studio.name || "舞室").slice(0, 20) },
    time3: { value: time },
    thing4: { value: "记得提前安排时间哦~" },
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
      schedule: { include: { studio: true } },
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