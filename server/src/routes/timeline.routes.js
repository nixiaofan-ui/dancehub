import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { getCityDaySchedules, getStudiosDaySchedules, toDateKey } from "../services/schedule.service.js";

import { shortStudioLabel } from "../lib/studio-name.js";

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { cityId, date } = req.query;
    if (!cityId) return fail(res, 400, "cityId 必填");
    const dateKey = date || toDateKey(new Date());

    const follows = await prisma.follow.findMany({
      where: { userId: req.userId },
      select: { studioId: true },
    });
    const followedStudioIds = new Set(follows.map((f) => f.studioId));

    const [schedules, bookings, reminders] = await Promise.all([
      getCityDaySchedules(cityId, dateKey, req.userId),
      prisma.booking.findMany({
        where: { userId: req.userId, schedule: { scheduleDate: new Date(dateKey) } },
        select: { scheduleId: true, status: true },
      }),
      prisma.reminder.findMany({
        where: { userId: req.userId, schedule: { scheduleDate: new Date(dateKey) } },
        select: { scheduleId: true },
      }),
    ]);

    const bookingMap = new Map(bookings.map((b) => [b.scheduleId, b.status]));
    const reminderSet = new Set(reminders.map((r) => r.scheduleId));

    // 课表默认只给「已关注舞室」的课 —— 但有两类课必须例外：
    // 1. 我自己约过的：否则「我的-预约记录」里有、课表里却没有，
    //    用户会以为数据没同步。典型场景是从发现页直接约了课但没关注那家舞室。
    // 2. 我自己录的：录入的店多半还没被抓取覆盖，要求先关注才能看见
    //    等于让用户录完看不到自己的劳动成果。
    const items = schedules
      .filter(
        (s) =>
          followedStudioIds.has(s.studio.id) || bookingMap.has(s.id) || s.mine
      )
      .map((s) => ({
        ...s,
        // 短名在服务端算好：发现页、门店 chips、课程卡片三处必须一致，
        // 前端各拆一次必然漂移（尤其是「（点击有地图指引）」这类营销尾巴）
        studio: { ...s.studio, short: shortStudioLabel(s.studio.name) },
        bookingStatus: bookingMap.get(s.id) || null,
        reminded: reminderSet.has(s.id),
        followed: followedStudioIds.has(s.studio.id),
      }));

    ok(res, {
      date: dateKey,
      cityId: Number(cityId),
      followedCount: followedStudioIds.size,
      items,
    });
  }),
);

/**
 * 多店合并课表：GET /api/timeline/multi?studioIds=1,2,3&date=2026-09-28
 *
 * 给「自选门店组」用 —— 三个入口共用这一个接口：
 *   1. 品牌多店：带该品牌同城全部分店
 *   2. 关注筛选：用户在课表页勾选的已关注门店
 *   3. 老师主页：该老师任教的所有门店
 * 与 /timeline 的差别只是「门店从哪来」，返回结构保持一致，
 * 前端可以复用同一套渲染。
 */
router.get(
  "/multi",
  requireAuth,
  asyncHandler(async (req, res) => {
    const raw = String(req.query.studioIds || "");
    // 上限 30 家：再多手机上没法比，且容易被刷成大查询
    const studioIds = [
      ...new Set(raw.split(",").map((s) => Number(s.trim())).filter(Boolean)),
    ].slice(0, 30);
    if (!studioIds.length) return fail(res, 400, "studioIds 必填");

    // 单日 or 区间：给了 from/to 就拉整周（多店视图切换星期不用重复请求）
    const single = req.query.date || toDateKey(new Date());
    const fromKey = req.query.from || single;
    const toKey = req.query.to || (req.query.from ? req.query.from : null);
    const dateRange = { gte: new Date(fromKey), lte: new Date(toKey || fromKey) };

    const [schedules, studios, bookings, reminders] = await Promise.all([
      getStudiosDaySchedules(studioIds, fromKey, toKey, req.userId),
      prisma.studio.findMany({
        where: { id: { in: studioIds }, status: true },
        select: { id: true, name: true, cityId: true },
      }),
      prisma.booking.findMany({
        where: { userId: req.userId, schedule: { scheduleDate: dateRange } },
        select: { scheduleId: true, status: true },
      }),
      prisma.reminder.findMany({
        where: { userId: req.userId, schedule: { scheduleDate: dateRange } },
        select: { scheduleId: true },
      }),
    ]);

    const bookingMap = new Map(bookings.map((b) => [b.scheduleId, b.status]));
    const reminderSet = new Set(reminders.map((r) => r.scheduleId));

    const items = schedules.map((s) => ({
      ...s,
      bookingStatus: bookingMap.get(s.id) || null,
      reminded: reminderSet.has(s.id),
    }));

    // 按传入顺序排门店，保证 chips 顺序稳定（用户勾选的顺序=他心里的优先级）
    const order = new Map(studioIds.map((id, i) => [id, i]));
    const studioList = studios
      .slice()
      .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
      .map((s) => ({
        id: s.id,
        name: s.name,
        cityId: s.cityId,
        // 门店短名：多店视图里卡片只放得下一个短标签
        short: shortStudioLabel(s.name),
        count: items.filter((i) => i.studio.id === s.id).length,
      }));

    ok(res, {
      date: single,
      from: fromKey,
      to: toKey || fromKey,
      studios: studioList,
      items,
    });
  }),
);

export default router;