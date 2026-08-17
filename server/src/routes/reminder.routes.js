import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { toDateKey } from "../services/schedule.service.js";

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
          include: { studio: true, coach: true },
        },
      },
      orderBy: { remindAt: "asc" },
    });
    ok(
      res,
      reminders.map((r) => ({
        id: r.id,
        status: r.status,
        remindAt: r.remindAt,
        schedule: {
          id: r.schedule.id,
          courseName: r.schedule.courseName,
          scheduleDate: toDateKey(r.schedule.scheduleDate),
          startTime: r.schedule.startTime.toTimeString().slice(0, 5),
          coach: r.schedule.coach?.name || null,
          studio: r.schedule.studio.name,
        },
      })),
    );
  }),
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { scheduleId } = req.body || {};
    if (!scheduleId) return fail(res, 400, "scheduleId 必填");

    const schedule = await prisma.schedule.findUnique({ where: { id: Number(scheduleId) } });
    if (!schedule) return fail(res, 404, "课程不存在");

    const scheduleAt = new Date(schedule.scheduleDate);
    const [h, m] = schedule.startTime.toTimeString().slice(0, 5).split(":").map(Number);
    scheduleAt.setHours(h, m, 0, 0);
    const remindAt = new Date(scheduleAt.getTime() - REMIND_LEAD_MS);

    const reminder = await prisma.reminder.upsert({
      where: { userId_scheduleId: { userId: req.userId, scheduleId: Number(scheduleId) } },
      update: { remindAt, status: "PENDING" },
      create: {
        userId: req.userId,
        scheduleId: Number(scheduleId),
        remindAt,
        status: "PENDING",
      },
    });
    ok(res, reminder, "已开启提醒");
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

export default router;