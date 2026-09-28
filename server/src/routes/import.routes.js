import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { createSchedule, parseDateKey } from "../services/schedule.service.js";

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
 * ⚠️ 这里记录是写进公共库的（门店不存在就新建，status=true）。
 * 取舍：录入的内容对别人也有用，藏起来等于白录。
 * 代价是理论上有人能乱填 —— 目前是体验版阶段，接受这个风险。
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
    });

    ok(
      res,
      { id: schedule.id, studioId: studio.id, studioCreated, coachId },
      studioCreated ? `已录入，并新建了门店「${studioName}」` : "已录入"
    );
  }),
);

export default router;
