import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok } from "../utils/response.js";
import { toDateKey } from "../services/schedule.service.js";

const router = Router();

router.get("/check", requireAdmin, (_req, res) => {
  ok(res, null, "admin ok");
});

router.get(
  "/bookings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { scheduleDate } = req.query;
    const where = {};
    if (scheduleDate) {
      where.schedule = { scheduleDate: new Date(scheduleDate) };
    }

    const rows = await prisma.booking.findMany({
      where,
      include: {
        user: { select: { id: true, nickname: true, openid: true } },
        schedule: {
          include: { studio: { include: { city: true } }, coach: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    ok(
      res,
      rows.map((b) => ({
        id: b.id,
        status: b.status,
        method: b.method,
        createdAt: b.createdAt,
        user: {
          id: b.user.id,
          nickname: b.user.nickname,
          openid: b.user.openid.replace(/^dev:/, "dev-"),
        },
        schedule: {
          id: b.schedule.id,
          courseName: b.schedule.courseName,
          scheduleDate: toDateKey(b.schedule.scheduleDate),
          startTime: b.schedule.startTime.toTimeString().slice(0, 5),
          endTime: b.schedule.endTime.toTimeString().slice(0, 5),
          difficulty: b.schedule.difficulty,
          coach: b.schedule.coach?.name || null,
          studio: b.schedule.studio.name,
          city: b.schedule.studio.city?.name,
        },
      })),
    );
  }),
);

export default router;