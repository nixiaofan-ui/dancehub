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

// 取消预约：直接删除记录（Booking 的 status 只有 PENDING/CONFIRMED，
// 加一个 CANCELLED 枚举要改表结构、还要在云库上跑迁移，收益却只是留一条历史
// —— 对用户来说「取消」就该从列表里消失，所以走物理删除）。
// 唯一键是 (userId, scheduleId)，所以取消后再预约会重新建一条，不会冲突。
router.delete(
  "/:scheduleId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const scheduleId = Number(req.params.scheduleId);
    if (!Number.isFinite(scheduleId)) return fail(res, 400, "scheduleId 非法");

    const existing = await prisma.booking.findUnique({
      where: { userId_scheduleId: { userId: req.userId, scheduleId } },
    });
    if (!existing) return fail(res, 404, "没有这条预约记录");

    // 开课提醒是独立设置，不跟着一起删（用户可能只是不想占位、但仍想被提醒）。
    // 但把「这节课还开着提醒」回传，前端提示一声，免得留下一条没人要的噪音提醒。
    const reminder = await prisma.reminder.findUnique({
      where: { userId_scheduleId: { userId: req.userId, scheduleId } },
    });

    await prisma.booking.delete({ where: { id: existing.id } });
    ok(res, { scheduleId, hasReminder: Boolean(reminder) }, "已取消预约");
  }),
);

router.get(
  "/pending-count",
  requireAuth,
  asyncHandler(async (req, res) => {
    const count = await prisma.booking.count({
      where: { userId: req.userId, status: "PENDING" },
    });
    ok(res, { count });
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