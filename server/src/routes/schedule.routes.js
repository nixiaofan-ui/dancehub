import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { getLiveBooking, refreshStudioDay } from "../lib/live-booking.js";
import { toLocalText } from "../services/reminder.service.js";
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  copyPreviousWeek,
  toDateKey,
} from "../services/schedule.service.js";
import { searchCourseVideo } from "../services/video.service.js";
import { resolveScheduleVideoUrl } from "../services/schedule-video.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { studioId, coachId, from, to } = req.query;
    const rows = await listSchedules({
      studioId,
      coachId,
      from,
      to,
      userId: req.userId,
    });
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
  "/:id/video-url",
  requireAuth,
  asyncHandler(async (req, res) => {
    const schedule = await prisma.schedule.findUnique({
      where: { id: Number(req.params.id) },
      select: { id: true, videoRef: true },
    });
    if (!schedule) return fail(res, 404, "课程不存在");
    if (!schedule.videoRef) return ok(res, { scheduleId: schedule.id, url: "" });

    // videoRef 有两形态：菲体云的「取址」（签名 1 小时，要回源换新）与魔方约课
    // 给的**永久公开直链**（直接用）。分派逻辑与理由见 services/schedule-video.js。
    // 取不到就返回空串，前端把「课程预告」整块藏掉，不影响约课。
    const url = await resolveScheduleVideoUrl(schedule.videoRef);
    ok(res, { scheduleId: schedule.id, url });
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

    // ⚠ 一节课可以挂两种提醒（CLASS 开课提醒 / SNIPE 抢课闹钟），唯一键已放宽到
    // 三元组，所以不能再 findUnique({userId_scheduleId})。分开取，别把闹钟的
    // 存在当成「开课提醒已开」——那样用户点按钮去关，关掉的是另一条，还很懵。
    const [booking, myReminders, bookedCount] = await Promise.all([
      prisma.booking.findUnique({
        where: { userId_scheduleId: { userId: req.userId, scheduleId: schedule.id } },
        select: { status: true },
      }),
      prisma.reminder.findMany({
        where: { userId: req.userId, scheduleId: schedule.id },
        select: { kind: true, status: true, remindAt: true },
      }),
      prisma.booking.count({ where: { scheduleId: schedule.id } }),
    ]);
    const classReminder = myReminders.find((r) => r.kind === "CLASS");
    // 只有还等着触发的闹钟才算「已设」；发过的留着是为了不重复 bombard
    const snipe = myReminders.find((r) => r.kind === "SNIPE" && r.status === "PENDING");

    ok(res, {
      id: schedule.id,
      courseName: schedule.courseName,
      difficulty: schedule.difficulty,
      scheduleDate: toDateKey(schedule.scheduleDate),
      startTime: schedule.startTime.toTimeString().slice(0, 5),
      endTime: schedule.endTime.toTimeString().slice(0, 5),
      bookingUrl: schedule.bookingUrl,
      // 课程封面图（iWOD 独有）
      coursePicUrl: schedule.coursePicUrl,
      // 这节课有没有上游的「课程预告视频」。只给标记不给地址 —— 地址是签名链接、
      // 1 小时过期，必须由前端另打 /:id/video-url 现取（见 fityun-video.js）。
      hasVideo: Boolean(schedule.videoRef),
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
        // 该店官方约课小程序 appId（有则详情页显示「跳转官方小程序预约」）
        bookingMiniAppId: schedule.studio.bookingMiniAppId,
        // 官网/官方预约页：海外店没有小程序，「去预约」改走 web-view 打开这个地址
        officialUrl: schedule.studio.officialUrl,
        contact: schedule.studio.contact,
        city: schedule.studio.city?.name,
        // 老师主页按「同城同名老师」聚合，跳过去要带城市；只给城市名的话
        // 前端还得再查一次城市表，这里直接带 id
        cityId: schedule.studio.cityId,
      },
      bookingStatus: booking ? booking.status : null,
      reminded: Boolean(classReminder),
      // 抢课闹钟：给的是东八区字符串，前端直接显示，不用自己转时区
      snipeRemindAt: snipe ? toLocalText(snipe.remindAt) : null,
      // ⚠ 这两个数字口径完全不同，别混：
      //   bookedCount = Booking 表计数 = **本小程序**用户约了几个人（几乎总是 0）
      //   bookedNum   = 舞室官方系统里的真实已约人数（可能为 null = 平台没提供）
      bookedCount,
      bookedNum: schedule.bookedNum,
      liveCheckedAt: schedule.updatedAt,
    });
  }),
);

/**
 * 批量实时刷新「一家店某一天」全部课的预约人数。
 *
 * 定时抓取出来的数字是快照（云端 6 小时一轮），热门课开抢后 11 人可能已经是
 * 几小时前的旧数。详情页走 /:id/live-booking 逐个回源没问题，
 * 但周课表/首页一屏十几节，必须一次刷完 —— 所以有这条按店按天的接口。
 * 回源失败/未接入该平台时返回 live=false，前端保持库里旧值，不报错。
 */
router.get(
  "/live-booking",
  requireAuth,
  asyncHandler(async (req, res) => {
    const studioId = Number(req.query.studioId);
    const date = String(req.query.date || "").slice(0, 10);
    if (!studioId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return fail(res, 400, "缺少 studioId 或 date");
    }
    const studio = await prisma.studio.findUnique({
      where: { id: studioId },
      include: { city: true },
    });
    if (!studio) return fail(res, 404, "门店不存在");
    const live = await refreshStudioDay(studio, new Date(`${date}T00:00:00Z`));
    ok(res, live);
  }),
);

/**
 * 实时刷新该课程的预约人数。
 * 详情页下拉/进入时调用；回源失败会静默降级到库里的旧值，不会抛错。
 */
router.get(
  "/:id/live-booking",
  requireAuth,
  asyncHandler(async (req, res) => {
    const schedule = await prisma.schedule.findUnique({
      where: { id: Number(req.params.id) },
      include: { studio: { include: { city: true } } },
    });
    if (!schedule) return fail(res, 404, "课程不存在");
    const live = await getLiveBooking(schedule);
    ok(res, live);
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