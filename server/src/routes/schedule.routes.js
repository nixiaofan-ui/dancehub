import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  copyPreviousWeek,
} from "../services/schedule.service.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { studioId, coachId, from, to } = req.query;
    const rows = await listSchedules({ studioId, coachId, from, to });
    ok(res, rows);
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