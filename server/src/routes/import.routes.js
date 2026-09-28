import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import {
  createSchedule,
  parseDateKey,
  invalidateTimelineCache,
} from "../services/schedule.service.js";

const router = Router();

/**
 * 用户手工录入课表：POST /api/imports/schedule
 *
 * 存在的理由：抓取只能覆盖用了那几套 SaaS 的店，头部独立舞室永远有漏，
 * 而这些恰恰是用户最想看的。与其我们一家家逆向，不如让用户自己录。
 *
 * 刻意做成「结构化逐条录入」而不是「粘贴文本自动解析」：
 * 各家公众号的课表排版五花八门（有的用 emoji 分隔、有的周视图横排、
 * 有的把教练写在课名里），自动解析看着聪明，解错了却没人会发现 ——
 * 课表这种数据，宁可录入慢一点，也不能错。
 *
 * 可见性：ownerId = 当前用户，只有本人能看见（抓取来的公共课 ownerId 为 null）。
 * 一开始默认写进公共库，后来改私有 —— 手录的内容没有任何校验，
 * 放公共库等于让所有人为一个人的录入质量买单；而「录给自己看」
 * 本来就是主要场景（补上那家没被抓取覆盖的店）。
 * 门店仍是公共的：门店只是个名字，不涉及对错，别人搜到同名店还能复用。
 */
router.post(
  "/schedule",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const studioName = String(body.studioName || "").trim();
    const dateKey = String(body.date || "").trim();
    const startTime = String(body.startTime || "").trim();
    const endTime = String(body.endTime || "").trim();
    const courseName = String(body.courseName || "").trim();
    const coachName = String(body.coachName || "").trim();
    const cityId = Number(body.cityId);

    if (!studioName || !dateKey || !startTime || !courseName) {
      return fail(res, 400, "门店、日期、开始时间、课程名必填");
    }
    if (!cityId) return fail(res, 400, "缺少城市");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return fail(res, 400, "日期格式应为 YYYY-MM-DD");
    if (!/^\d{2}:\d{2}$/.test(startTime)) return fail(res, 400, "时间格式应为 HH:MM");
    if (endTime && !/^\d{2}:\d{2}$/.test(endTime)) return fail(res, 400, "时间格式应为 HH:MM");

    const endTimeFinal = endTime || startTime;

    // 同名门店复用 —— 同城同名大概率就是同一家，
    // 建重了会变成两家都只有一半课的鬼影门店
    let studio = await prisma.studio.findFirst({
      where: { cityId, name: studioName },
      select: { id: true },
    });
    let studioCreated = false;
    if (!studio) {
      studio = await prisma.studio.create({
        data: { cityId, name: studioName, platform: "OTHER", status: true },
        select: { id: true },
      });
      studioCreated = true;
    }

    // 教练同理：Coach 挂在门店下，换家店就得重认
    let coachId = null;
    if (coachName) {
      let coach = await prisma.coach.findFirst({
        where: { studioId: studio.id, name: coachName },
        select: { id: true },
      });
      if (!coach) {
        coach = await prisma.coach.create({
          data: { studioId: studio.id, name: coachName },
          select: { id: true },
        });
      }
      coachId = coach.id;
    }

    const schedule = await createSchedule({
      studioId: studio.id,
      coachId,
      courseName,
      difficulty: body.difficulty || "ALL_LEVELS",
      scheduleDate: parseDateKey(dateKey),
      startTime: new Date(`1970-01-01T${startTime}:00`),
      endTime: new Date(`1970-01-01T${endTimeFinal}:00`),
      remark: body.remark || "用户录入",
      ownerId: req.userId,
    });

    ok(
      res,
      { id: schedule.id, studioId: studio.id, studioCreated, coachId },
      studioCreated ? `已录入，并新建了门店「${studioName}」` : "已录入"
    );
  }),
);

/**
 * 我录过的课：GET /api/imports/mine
 * 录入是私有的，所以必须有个地方能回看/删掉 —— 只让录不让删，
 * 填错日期的人只能干看着一条永远出现在错误日期的课。
 */
router.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await prisma.schedule.findMany({
      where: { ownerId: req.userId },
      include: {
        studio: { include: { city: true } },
        coach: true,
      },
      orderBy: [{ scheduleDate: "asc" }, { startTime: "asc" }],
    });

    ok(
      res,
      rows.map((s) => ({
        id: s.id,
        courseName: s.courseName,
        date: s.scheduleDate.toISOString().slice(0, 10),
        startTime: s.startTime.toTimeString().slice(0, 5),
        endTime: s.endTime.toTimeString().slice(0, 5),
        coachName: s.coach ? s.coach.name : "",
        studioName: s.studio.name,
        cityName: s.studio.city ? s.studio.city.name : "",
        difficulty: s.difficulty,
      }))
    );
  }),
);

/**
 * 删除自己录的课：DELETE /api/imports/schedule/:id
 * 只允许删 ownerId 是自己那条 —— 用 where 带 ownerId 而不是先查后判，
 * 避免「查到 → 判断」之间的空档被打穿。
 */
router.delete(
  "/schedule/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const r = await prisma.schedule.deleteMany({
      where: { id, ownerId: req.userId },
    });
    if (!r.count) return fail(res, 404, "没找到这条记录，或它不是你录的");
    await invalidateTimelineCache();
    ok(res, { id }, "已删除");
  }),
);

export default router;
