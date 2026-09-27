import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

// Prisma 把 MySQL 的 TIME 读成 Date（1970-01-01 + 时间），统一截成 "HH:mm"。
// ⚠ 用 toTimeString()（本地时区）而不是 getUTCHours —— 全站的时间显示都是这个口径
// （/bookings、/timeline 都这么取），改了就会和前端对不上。两边同口径，比较仍然成立。
const hhmm = (t) => (t instanceof Date ? t.toTimeString() : String(t || "")).slice(0, 5);

/**
 * 同一天里时段相交的其他预约。
 * 按半开区间 [start, end) 判断：10:00-11:00 和 11:00-12:00 首尾相接不算冲突，
 * 上一节下课正好赶下一节是常态，误报会把人烦死。
 */
async function findConflicts(userId, schedule) {
  const sameDay = await prisma.booking.findMany({
    where: { userId, schedule: { scheduleDate: schedule.scheduleDate } },
    include: { schedule: { include: { studio: true } } },
  });
  const s1 = hhmm(schedule.startTime);
  const e1 = hhmm(schedule.endTime);
  return sameDay
    .filter((b) => b.scheduleId !== schedule.id)
    .filter((b) => {
      const s2 = hhmm(b.schedule.startTime);
      const e2 = hhmm(b.schedule.endTime);
      return s1 < e2 && s2 < e1;
    })
    .map((b) => ({
      scheduleId: b.scheduleId,
      courseName: b.schedule.courseName,
      startTime: hhmm(b.schedule.startTime),
      endTime: hhmm(b.schedule.endTime),
      studio: b.schedule.studio ? b.schedule.studio.name : "",
      status: b.status,
    }));
}

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
    const { scheduleId, method, force } = req.body || {};
    if (!scheduleId) return fail(res, 400, "scheduleId 必填");

    const schedule = await prisma.schedule.findUnique({ where: { id: Number(scheduleId) } });
    if (!schedule) return fail(res, 404, "课程不存在");

    const isManual = method === "MANUAL";
    const existing = await prisma.booking.findUnique({
      where: { userId_scheduleId: { userId: req.userId, scheduleId: Number(scheduleId) } },
    });

    // 撞课检测：同一时间上不了两节课。已约过这节（existing）不算冲突，
    // 那是重复点击。默认只是「提醒」，用户坚持可以带 force 重发。
    if (!existing && !force) {
      const conflicts = await findConflicts(req.userId, schedule);
      if (conflicts.length) {
        return fail(
          res,
          409,
          `与已预约的「${conflicts[0].courseName}」时间冲突（${conflicts[0].startTime}-${conflicts[0].endTime}）`,
          { conflicts },
        );
      }
    }

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

    // 开课提醒跟着一起删：课都不去了，再弹一条「该上课了」纯粹是噪音。
    // （以前是保留的，理由是「用户可能只是不想占位但仍想被提醒」—— 实际没人这么用，
    //   反而留下一堆取消后照样推送的记录。真想被提醒，重新约一次即可。）
    const reminder = await prisma.reminder.findUnique({
      where: { userId_scheduleId: { userId: req.userId, scheduleId } },
    });
    if (reminder) {
      await prisma.reminder.delete({ where: { id: reminder.id } });
    }

    await prisma.booking.delete({ where: { id: existing.id } });
    ok(
      res,
      { scheduleId, hasReminder: Boolean(reminder), reminderRemoved: Boolean(reminder) },
      reminder ? "已取消预约，开课提醒也关掉了" : "已取消预约",
    );
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