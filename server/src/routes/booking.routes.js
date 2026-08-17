import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookings = await prisma.booking.findMany({
      where: { userId: req.userId },
      include: {
        schedule: {
          include: {
            studio: { include: { city: true } },
            coach: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    ok(
      res,
      bookings.map((b) => ({
        id: b.id,
        status: b.status,
        method: b.method,
        createdAt: b.createdAt,
        schedule: {
          id: b.schedule.id,
          courseName: b.schedule.courseName,
          difficulty: b.schedule.difficulty,
          scheduleDate: b.schedule.scheduleDate,
          startTime: b.schedule.startTime.toTimeString().slice(0, 5),
          endTime: b.schedule.endTime.toTimeString().slice(0, 5),
          coach: b.schedule.coach?.name || null,
          studio: b.schedule.studio.name,
          studioId: b.schedule.studioId,
          city: b.schedule.studio.city?.name,
        },
      })),
    );
  }),
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { scheduleId, method } = req.body || {};
    if (!scheduleId) return fail(res, 400, "scheduleId 必填");

    const schedule = await prisma.schedule.findUnique({ where: { id: Number(scheduleId) } });
    if (!schedule) return fail(res, 404, "课程不存在");

    const isManual = method === "MANUAL";
    const existing = await prisma.booking.findUnique({
      where: { userId_scheduleId: { userId: req.userId, scheduleId: Number(scheduleId) } },
    });

    const booking = existing
      ? await prisma.booking.update({
          where: { id: existing.id },
          data: {
            status: isManual ? "CONFIRMED" : existing.status,
            method: existing.method === "MANUAL" ? existing.method : method || "JUMP",
          },
        })
      : await prisma.booking.create({
          data: {
            userId: req.userId,
            scheduleId: Number(scheduleId),
            status: isManual ? "CONFIRMED" : "PENDING",
            method: method || "JUMP",
          },
        });

    ok(res, booking, isManual ? "已约好" : "已跳转，待确认");
  }),
);

router.put(
  "/:scheduleId/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await prisma.booking.findUnique({
      where: { userId_scheduleId: { userId: req.userId, scheduleId: Number(req.params.scheduleId) } },
    });
    if (!existing) return fail(res, 404, "尚无预约记录，请先点击预约");

    const booking = await prisma.booking.update({
      where: { id: existing.id },
      data: { status: "CONFIRMED" },
    });
    ok(res, booking, "已确认预约");
  }),
);

export default router;