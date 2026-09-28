import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { getCoachSchedules, toDateKey, addDays } from "../services/schedule.service.js";
import { shortStudioLabel } from "../lib/studio-name.js";

const router = Router();

/**
 * 老师主页：GET /api/coaches/timeline?name=Kennis&cityId=17&days=14
 *
 * 舞蹈用户是跟着老师选课的（统计显示 25%~40% 的老师跨店教），
 * 所以这个维度的优先级不比门店低。返回这块老师任教的门店清单 + 未来课程，
 * 前端按「日期 → 门店」两层分组展示。
 */
router.get(
  "/timeline",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, cityId } = req.query;
    if (!name) return fail(res, 400, "name 必填");
    if (!cityId) return fail(res, 400, "cityId 必填");

    const today = toDateKey(new Date());
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 30);
    const to = addDays(today, days - 1);

    const [schedules, bookings] = await Promise.all([
      getCoachSchedules(name, cityId, today, to, req.userId),
      prisma.booking.findMany({
        where: {
          userId: req.userId,
          schedule: { scheduleDate: { gte: new Date(today), lte: new Date(to) } },
        },
        select: { scheduleId: true, status: true },
      }),
    ]);

    const bookingMap = new Map(bookings.map((b) => [b.scheduleId, b.status]));

    // 任教门店清单：这老师到底在几家店跑，是这张页最有信息量的一句话
    const studioMap = new Map();
    schedules.forEach((s) => {
      if (!studioMap.has(s.studio.id)) {
        studioMap.set(s.studio.id, {
          id: s.studio.id,
          name: s.studio.name,
          short: shortStudioLabel(s.studio.name),
          cityId: s.studio.cityId,
          count: 0,
        });
      }
      studioMap.get(s.studio.id).count += 1;
    });

    const items = schedules.map((s) => ({
      ...s,
      studio: { ...s.studio, short: shortStudioLabel(s.studio.name) },
      bookingStatus: bookingMap.get(s.id) || null,
    }));

    ok(res, {
      name,
      cityId: Number(cityId),
      from: today,
      to,
      studios: [...studioMap.values()].sort((a, b) => b.count - a.count),
      items,
    });
  }),
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { studioId } = req.query;
    const where = studioId ? { studioId: Number(studioId) } : {};
    const coaches = await prisma.coach.findMany({
      where,
      include: { studio: { select: { id: true, name: true } } },
      orderBy: { id: "desc" },
    });
    ok(res, coaches);
  }),
);

router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { studioId, name, avatarUrl } = req.body || {};
    if (!studioId || !name) return fail(res, 400, "studioId 和 name 必填");
    const coach = await prisma.coach.create({
      data: { studioId: Number(studioId), name, avatarUrl: avatarUrl || null },
    });
    ok(res, coach, "创建成功");
  }),
);

router.put(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { studioId, name, avatarUrl } = req.body || {};
    const data = {};
    if (studioId !== undefined) data.studioId = Number(studioId);
    if (name !== undefined) data.name = name;
    if (avatarUrl !== undefined) data.avatarUrl = avatarUrl;

    const coach = await prisma.coach.update({ where: { id: Number(req.params.id) }, data });
    ok(res, coach, "更新成功");
  }),
);

router.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await prisma.coach.delete({ where: { id: Number(req.params.id) } });
    ok(res, null, "删除成功");
  }),
);

export default router;