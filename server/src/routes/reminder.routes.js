import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { toDateKey } from "../services/schedule.service.js";
import { sendDueReminders } from "../services/reminder.service.js";

const REMIND_LEAD_MS = 2 * 60 * 60 * 1000;

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const reminders = await prisma.reminder.findMany({
      where: { userId: req.userId },
      include: {
        schedule: {
          include: { studio: { include: { city: true } }, coach: true },
        },
      },
      orderBy: { remindAt: "asc" },
    });
    ok(
      res,
      reminders.map((r) => ({
        id: r.id,
        status: r.status,
        type: r.type,
        remindAt: r.remindAt,
        schedule: {
          id: r.schedule.id,
          courseName: r.schedule.courseName,
          scheduleDate: toDateKey(r.schedule.scheduleDate),
          startTime: r.schedule.startTime.toTimeString().slice(0, 5),
          coach: r.schedule.coach?.name || null,
          studio: r.schedule.studio.name,
          city: r.schedule.studio.city?.name || null,
        },
      })),
    );
  }),
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { scheduleId, subscribe } = req.body || {};
    if (!scheduleId) return fail(res, 400, "scheduleId 必填");

    const schedule = await prisma.schedule.findUnique({ where: { id: Number(scheduleId) } });
    if (!schedule) return fail(res, 404, "课程不存在");

    const scheduleAt = new Date(schedule.scheduleDate);
    const [h, m] = schedule.startTime.toTimeString().slice(0, 5).split(":").map(Number);
    scheduleAt.setHours(h, m, 0, 0);
    const remindAt = new Date(scheduleAt.getTime() - REMIND_LEAD_MS);

    // 仅当用户授权订阅且已配置模板时，才走订阅消息推送
    const subscribeTplId =
      subscribe && config.wechat.classReminderTplId ? config.wechat.classReminderTplId : null;

    const reminder = await prisma.reminder.upsert({
      where: { userId_scheduleId: { userId: req.userId, scheduleId: Number(scheduleId) } },
      update: {
        remindAt,
        status: "PENDING",
        sentAt: null,
        subscribeTplId,
        type: subscribeTplId ? "SUBSCRIBE" : "LOCAL",
      },
      create: {
        userId: req.userId,
        scheduleId: Number(scheduleId),
        remindAt,
        status: "PENDING",
        subscribeTplId,
        type: subscribeTplId ? "SUBSCRIBE" : "LOCAL",
      },
    });
    ok(res, reminder, subscribeTplId ? "已开启订阅消息提醒" : "已开启本地提醒");
  }),
);

router.delete(
  "/:scheduleId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.reminder.deleteMany({
      where: { userId: req.userId, scheduleId: Number(req.params.scheduleId) },
    });
    ok(res, null, "已关闭提醒");
  }),
);

// 定时触发器入口（云托管控制台配 cron 调用；服务未开外网，仅平台侧可达）。
// 扫描到期提醒并推送订阅消息；跑得快（≤50 条/轮），同步返回结果。
let reminderTicking = false;
router.post(
  "/tick",
  asyncHandler(async (req, res) => {
    if (reminderTicking) return ok(res, { started: false, reason: "already-running" });
    reminderTicking = true;
    try {
      const r = await sendDueReminders();
      ok(res, { started: true, ...r });
    } finally {
      reminderTicking = false;
    }
  }),
);

export default router;