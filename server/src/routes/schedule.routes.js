import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  copyPreviousWeek,
  toDateKey,
} from "../services/schedule.service.js";
import { searchCourseVideo } from "../services/video.service.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { studioId, coachId, from, to } = req.query;
    const rows = await listSchedules({ studioId, coachId, from, to });
    ok(res, rows);
  }),
);

router.get(
  "/:id/video-preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const schedule = await prisma.schedule.findUnique({
      where: { id: Number(req.params.id) },
      include: { studio: true, coach: true },
    });
    if (!schedule) return fail(res, 404, "课程不存在");

    const keyword = [schedule.studio.name, schedule.courseName, schedule.coach?.name]
      .filter(Boolean)
      .join(" ");
    const videos = await searchCourseVideo({ keyword });

    ok(res, {
      scheduleId: schedule.id,
      platform: schedule.studio.platform,
      keyword,
      items: videos,
    });
  }),
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const schedule = await prisma.schedule.findUnique({
      where: { id: Number(req.params.id) },
      include: { studio: { include: { city: true } }, coach: true },
    });
    if (!schedule) return fail(res, 404, "课程不存在");

    const [booking, reminder, bookedCount] = await Promise.all([
      prisma.booking.findUnique({
        where: { userId_scheduleId: { userId: req.userId, scheduleId: schedule.id } },
        select: { status: true },
      }),
      prisma.reminder.findUnique({
        where: { userId_scheduleId: { userId: req.userId, scheduleId: schedule.id } },
        select: { type: true },
      }),
      prisma.booking.count({ where: { scheduleId: schedule.id } }),
    ]);

    ok(res, {
      id: schedule.id,
      courseName: schedule.courseName,
      difficulty: schedule.difficulty,
      scheduleDate: toDateKey(schedule.scheduleDate),
      startTime: schedule.startTime.toTimeString().slice(0, 5),
      endTime: schedule.endTime.toTimeString().slice(0, 5),
      bookingUrl: schedule.bookingUrl,
      capacity: schedule.capacity,
      remark: schedule.remark,
      coach: schedule.coach
        ? { id: schedule.coach.id, name: schedule.coach.name, avatarUrl: schedule.coach.avatarUrl }
        : null,
      studio: {
        id: schedule.studio.id,
        name: schedule.studio.name,
        address: schedule.studio.address,
        platform: schedule.studio.platform,
        logoUrl: schedule.studio.logoUrl,
        city: schedule.studio.city?.name,
      },
      bookingStatus: booking ? booking.status : null,
      reminded: Boolean(reminder),
      bookedCount,
    });
  }),
);

router.post(
  "/copy-previous-week",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { start, end } = req.body || {};
    if (!start || !end) return fail(res, 400, "start 和 end 日期必填");
    const result = await copyPreviousWeek({ start, end });
    ok(res, result, "复制完成");
  }),
);

router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { studioId, coachId, courseName, difficulty, scheduleDate, startTime, endTime, bookingUrl, remark } =
      req.body || {};
    if (!studioId || !courseName || !scheduleDate || !startTime || !endTime) {
      return fail(res, 400, "studioId/courseName/scheduleDate/startTime/endTime 必填");
    }
    const schedule = await createSchedule({
      studioId: Number(studioId),
      coachId: coachId ? Number(coachId) : null,
      courseName,
      difficulty: difficulty || "ALL_LEVELS",
      scheduleDate: new Date(scheduleDate),
      startTime: new Date(`1970-01-01T${startTime}:00`),
      endTime: new Date(`1970-01-01T${endTime}:00`),
      bookingUrl: bookingUrl || null,
      remark: remark || null,
    });
    ok(res, schedule, "创建成功");
  }),
);

router.put(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { studioId, coachId, courseName, difficulty, scheduleDate, startTime, endTime, bookingUrl, remark } =
      req.body || {};
    const data = {};
    if (studioId !== undefined) data.studioId = Number(studioId);
    if (coachId !== undefined) data.coachId = coachId ? Number(coachId) : null;
    if (courseName !== undefined) data.courseName = courseName;
    if (difficulty !== undefined) data.difficulty = difficulty;
    if (scheduleDate !== undefined) data.scheduleDate = new Date(scheduleDate);
    if (startTime !== undefined) data.startTime = new Date(`1970-01-01T${startTime}:00`);
    if (endTime !== undefined) data.endTime = new Date(`1970-01-01T${endTime}:00`);
    if (bookingUrl !== undefined) data.bookingUrl = bookingUrl;
    if (remark !== undefined) data.remark = remark;

    const schedule = await updateSchedule(Number(req.params.id), data);
    ok(res, schedule, "更新成功");
  }),
);

router.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await deleteSchedule(Number(req.params.id));
    ok(res, null, "删除成功");
  }),
);

export default router;