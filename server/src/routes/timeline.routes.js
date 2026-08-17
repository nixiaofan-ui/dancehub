import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { getCityDaySchedules, toDateKey } from "../services/schedule.service.js";

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { cityId, date } = req.query;
    if (!cityId) return fail(res, 400, "cityId 必填");
    const dateKey = date || toDateKey(new Date());

    const follows = await prisma.follow.findMany({
      where: { userId: req.userId },
      select: { studioId: true },
    });
    const followedStudioIds = new Set(follows.map((f) => f.studioId));

    const [schedules, bookings, reminders] = await Promise.all([
      getCityDaySchedules(cityId, dateKey),
      prisma.booking.findMany({
        where: { userId: req.userId, schedule: { scheduleDate: new Date(dateKey) } },
        select: { scheduleId: true, status: true },
      }),
      prisma.reminder.findMany({
        where: { userId: req.userId, schedule: { scheduleDate: new Date(dateKey) } },
        select: { scheduleId: true },
      }),
    ]);

    const bookingMap = new Map(bookings.map((b) => [b.scheduleId, b.status]));
    const reminderSet = new Set(reminders.map((r) => r.scheduleId));

    const items = schedules
      .filter((s) => followedStudioIds.has(s.studio.id))
      .map((s) => ({
        ...s,
        bookingStatus: bookingMap.get(s.id) || null,
        reminded: reminderSet.has(s.id),
      }));

    ok(res, {
      date: dateKey,
      cityId: Number(cityId),
      followedCount: followedStudioIds.size,
      items,
    });
  }),
);

export default router;