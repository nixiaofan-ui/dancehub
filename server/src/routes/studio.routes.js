import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { toDateKey, parseDateKey, visibleScope } from "../services/schedule.service.js";
import { pickStyles } from "../services/dance-style.service.js";
import { sortStudiosByName } from "../services/studio-sort.service.js";
import { splitBrandBranch } from "../lib/studio-name.js";

const router = Router();

/** 当天 UTC 零点，用于匹配 @db.Date 的 scheduleDate */
function todayUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * 聚合每家门店未来课表的课名，解析出代表舞种标签
 * @param {number[]} studioIds
 * @returns {Promise<Map<number, string[]>>}
 */
async function buildStyleMap(studioIds) {
  const map = new Map();
  if (!studioIds.length) return map;

  const rows = await prisma.schedule.groupBy({
    by: ["studioId", "courseName"],
    where: { studioId: { in: studioIds }, scheduleDate: { gte: todayUtc() } },
    _count: { _all: true },
  });

  const byStudio = new Map();
  for (const r of rows) {
    if (!byStudio.has(r.studioId)) byStudio.set(r.studioId, []);
    byStudio.get(r.studioId).push({ courseName: r.courseName, count: r._count._all });
  }
  for (const [id, list] of byStudio) {
    map.set(id, pickStyles(list, 4));
  }
  return map;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { cityId, keyword, includeInactive } = req.query;
    const where = {};
    // 停用的舞室默认不出现在发现页；管理端可传 includeInactive=1 查看全部
    if (includeInactive !== "1") where.status = true;
    if (cityId) where.cityId = Number(cityId);
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { address: { contains: keyword } },
      ];
    }
    const studios = await prisma.studio.findMany({
      where,
      include: { city: true, _count: { select: { schedules: true, coaches: true } } },
    });

    const styleMap = await buildStyleMap(studios.map((s) => s.id));
    // 按名称首字母排序（中文走拼音），并给每家带上分组字母，供发现页右侧索引条定位
    ok(
      res,
      sortStudiosByName(studios).map((s) => ({
        ...s,
        styles: styleMap.get(s.id) || [],
      })),
    );
  }),
);

/**
 * 同城多店品牌：GET /api/studios/brands?cityId=17
 *
 * 门店名是「品牌·分店」格式，按「·」前面的部分聚合成品牌。
 * 只返回同城 ≥2 家门店的品牌 —— 单店品牌没有「合并看课」的价值，
 * 它的入口就是门店本身。
 *
 * ⚠️ 依赖名字格式，属轻量方案：648 家没走 SaaS 品牌归一化的单店名
 * 无法参与（它们的 name 没有分隔符）。正式建 Brand 表前先用这个，
 * 代价是覆盖率不全，好处是立刻能用且不需要回填历史数据。
 */
router.get(
  "/brands",
  asyncHandler(async (req, res) => {
    const { cityId } = req.query;
    if (!cityId) return fail(res, 400, "cityId 必填");

    const studios = await prisma.studio.findMany({
      where: { cityId: Number(cityId), status: true },
      select: { id: true, name: true },
    });

    const map = new Map();
    for (const s of studios) {
      // 品牌名统一走 splitBrandBranch：「·」和「（分店）」两种写法都认。
      // 只认「·」时「MAX POWER STUDIO（汶水路店）」这类老数据会被当成单店，
      // 同城三家分店聚不成品牌，发现页品牌条里就漏了它（2026-09-28 修）
      const { brand, branch } = splitBrandBranch(s.name);
      if (!brand) continue;
      if (!map.has(brand)) map.set(brand, []);
      map.get(brand).push({ id: s.id, name: s.name, branch });
    }

    const brands = [...map.entries()]
      .filter(([, stores]) => stores.length >= 2)
      .map(([name, stores]) => ({
        name,
        storeCount: stores.length,
        stores: stores.slice().sort((a, b) => a.branch.localeCompare(b.branch, "zh")),
      }))
      .sort((a, b) => b.storeCount - a.storeCount || a.name.localeCompare(b.name, "zh"));

    ok(res, brands);
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const studio = await prisma.studio.findUnique({
      where: { id: Number(req.params.id) },
      include: { city: true, coaches: true },
    });
    if (!studio) return fail(res, 404, "舞室不存在");
    ok(res, studio);
  }),
);

router.get(
  "/:id/today-schedules",
  requireAuth,
  asyncHandler(async (req, res) => {
    const studioId = Number(req.params.id);
    const studio = await prisma.studio.findUnique({
      where: { id: studioId },
      select: { id: true, status: true },
    });
    if (!studio || !studio.status) return fail(res, 404, "舞室不存在");

    const dateKey = req.query.date || toDateKey(new Date());
    const schedules = await prisma.schedule.findMany({
      where: {
        studioId,
        scheduleDate: parseDateKey(dateKey),
        ...visibleScope(req.userId),
      },
      include: { coach: true },
      orderBy: { startTime: "asc" },
    });
    const ids = schedules.map((s) => s.id);

    const [bookings, reminders] = await Promise.all([
      prisma.booking.findMany({
        where: { userId: req.userId, scheduleId: { in: ids } },
        select: { scheduleId: true, status: true },
      }),
      prisma.reminder.findMany({
        where: { userId: req.userId, scheduleId: { in: ids } },
        select: { scheduleId: true },
      }),
    ]);
    const bookingMap = new Map(bookings.map((b) => [b.scheduleId, b.status]));
    const reminderSet = new Set(reminders.map((r) => r.scheduleId));

    ok(res, {
      date: dateKey,
      studioId,
      items: schedules.map((s) => ({
        id: s.id,
        courseName: s.courseName,
        difficulty: s.difficulty,
        scheduleDate: toDateKey(s.scheduleDate),
        startTime: s.startTime.toTimeString().slice(0, 5),
        endTime: s.endTime.toTimeString().slice(0, 5),
        bookingUrl: s.bookingUrl,
        // 课程封面图（iWOD 独有，菲体云暂无）
        coursePicUrl: s.coursePicUrl,
        remark: s.remark,
        coach: s.coach ? { id: s.coach.id, name: s.coach.name } : null,
        bookingStatus: bookingMap.get(s.id) || null,
        reminded: reminderSet.has(s.id),
      })),
    });
  }),
);

router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { cityId, name, address, contact, logoUrl, platform, status } = req.body || {};
    if (!cityId || !name) return fail(res, 400, "cityId 和 name 必填");
    const studio = await prisma.studio.create({
      data: {
        cityId: Number(cityId),
        name,
        address: address || null,
        contact: contact || null,
        logoUrl: logoUrl || null,
        platform: platform || "WECHAT",
        status: status !== undefined ? Boolean(status) : true,
      },
    });
    ok(res, studio, "创建成功");
  }),
);

router.put(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { cityId, name, address, contact, logoUrl, platform, status } = req.body || {};
    const data = {};
    if (cityId !== undefined) data.cityId = Number(cityId);
    if (name !== undefined) data.name = name;
    if (address !== undefined) data.address = address;
    if (contact !== undefined) data.contact = contact;
    if (logoUrl !== undefined) data.logoUrl = logoUrl;
    if (platform !== undefined) data.platform = platform;
    if (status !== undefined) data.status = Boolean(status);

    const studio = await prisma.studio.update({
      where: { id: Number(req.params.id) },
      data,
    });
    ok(res, studio, "更新成功");
  }),
);

router.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const studio = await prisma.studio.update({
      where: { id: Number(req.params.id) },
      data: { status: false },
    });
    ok(res, { id: studio.id }, "已停用");
  }),
);

export default router;