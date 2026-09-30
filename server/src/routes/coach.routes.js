import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import {
  getCoachSchedules,
  toDateKey,
  addDays,
  parseDateKey,
  visibleScope,
} from "../services/schedule.service.js";
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
    // direction=past → 过去 N 天。为什么需要它：多数舞室只放当天/最近几天的课，
    // 「未来两周 N 节课」经常是 0，看着像没数据；而库里保留了历史课，
    // 用「上周排课规律」（周几 · 哪家店 · 几点 · 什么课）描述这位老师，信息量更高。
    const past = req.query.direction === "past";
    const from = past ? addDays(today, -days) : today;
    const to = past ? addDays(today, -1) : addDays(today, days - 1);

    const [schedules, bookings] = await Promise.all([
      getCoachSchedules(name, cityId, from, to, req.userId),
      prisma.booking.findMany({
        where: {
          userId: req.userId,
          schedule: { scheduleDate: { gte: new Date(from), lte: new Date(to) } },
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
      direction: past ? "past" : "future",
      from,
      to,
      studios: [...studioMap.values()].sort((a, b) => b.count - a.count),
      items,
    });
  }),
);

/**
 * 按名字找同城的老师记录。
 *
 * 三档渐进：精确 → 前缀 → 包含。前两档能走 Coach.name 索引，「包含」是兜底
 * （库里的老师名常带尾巴，例如 "Kennis "、"Kennis(代课)"）。
 * ⚠ 命中一档就停：用户输全名时，再放宽只会把同名的人一起捞进来。
 */
async function matchCoaches(keyword, cityId, take) {
  // cityId 为 0 / 空 = 全国：不加城市条件，只要求门店在线
  const base = cityId ? { studio: { cityId, status: true } } : { studio: { status: true } };
  const include = {
    studio: { select: { id: true, name: true, cityId: true, city: { select: { id: true, name: true } } } },
  };
  const modes = [{ equals: keyword }, { startsWith: keyword }, { contains: keyword }];
  for (const name of modes) {
    const rows = await prisma.coach.findMany({ where: { ...base, name }, include, take });
    if (rows.length) return rows;
  }
  return [];
}

/**
 * Coach 记录 → 按名字聚成的组（同城同名不合并成一个人，组内按门店单列）。
 * 同城搜和全国兜底共用这一段，免得两处算法各写一份然后悄悄分叉。
 */
async function buildGroups(coaches, userId) {
  const ids = coaches.map((c) => c.id);
  const today = parseDateKey(toDateKey(new Date()));
  const scope = { ...visibleScope(userId), studio: { status: true } };

  // 未来/历史各聚合一次：前者决定「还能不能去上」，后者在多数舞室只放
  // 最近几天课时是唯一有信息量的描述（这老师上周固定周几在哪上课）
  const [future, past] = ids.length
    ? await Promise.all([
        prisma.schedule.groupBy({
          by: ["coachId"],
          where: { ...scope, coachId: { in: ids }, scheduleDate: { gte: today } },
          _count: { _all: true },
          _min: { scheduleDate: true },
        }),
        prisma.schedule.groupBy({
          by: ["coachId"],
          where: { ...scope, coachId: { in: ids }, scheduleDate: { lt: today } },
          _count: { _all: true },
          _max: { scheduleDate: true },
        }),
      ])
    : [[], []];

  const fut = new Map(future.map((r) => [r.coachId, r]));
  const his = new Map(past.map((r) => [r.coachId, r]));

  const byName = new Map();
  coaches.forEach((c) => {
    const f = fut.get(c.id);
    const p = his.get(c.id);
    const city = c.studio && c.studio.city;
    const entry = {
      coachId: c.id,
      studioId: c.studio.id,
      studioName: c.studio.name,
      short: shortStudioLabel(c.studio.name),
      cityId: city ? city.id : c.studio.cityId || 0,
      cityName: city ? city.name : "",
      upcoming: f ? Number(f._count._all) : 0,
      past: p ? Number(p._count._all) : 0,
      nextDate: f && f._min.scheduleDate ? toDateKey(f._min.scheduleDate) : "",
      lastDate: p && p._max.scheduleDate ? toDateKey(p._max.scheduleDate) : "",
    };
    let g = byName.get(c.name);
    if (!g) {
      g = { name: c.name, avatarUrl: c.avatarUrl || "", studios: [] };
      byName.set(c.name, g);
    }
    // 头像可能有店有、有店没有 → 别让空值把已有的覆盖掉
    if (!g.avatarUrl && c.avatarUrl) g.avatarUrl = c.avatarUrl;
    g.studios.push(entry);
  });

  const groups = [...byName.values()].map((g) => {
    const studios = g.studios.sort(
      (a, b) =>
        (b.nextDate ? 1 : 0) - (a.nextDate ? 1 : 0) ||
        String(a.nextDate || "9999").localeCompare(String(b.nextDate || "9999")) ||
        b.upcoming + b.past - (a.upcoming + a.past),
    );
    const total = studios.reduce((n, s) => n + s.upcoming + s.past, 0);
    const nexts = studios.map((s) => s.nextDate).filter(Boolean).sort();
    const lasts = studios.map((s) => s.lastDate).filter(Boolean).sort();
    const cityNames = [...new Set(studios.map((s) => s.cityName).filter(Boolean))];
    return {
      name: g.name,
      avatarUrl: g.avatarUrl,
      studioCount: studios.length,
      totalCourses: total,
      upcoming: studios.reduce((n, s) => n + s.upcoming, 0),
      nextDate: nexts[0] || "",
      lastDate: lasts[lasts.length - 1] || "",
      // 同名多店：前端要把它讲清楚（「同名 3 家店」），不能默认是一个人
      multiStudio: studios.length > 1,
      // 全国兜底时才用得上：结果跨城，卡片必须标出是哪座城
      cityNames,
      // 前端点卡片跳老师主页要知道去哪座城市（取主门店的城市）
      cityId: studios[0] ? studios[0].cityId : 0,
      studios,
    };
  });

  // 近期有课的排前面：搜到一位下周有课的老师，比搜到一位去年教过的有用得多
  groups.sort(
    (a, b) =>
      (b.nextDate ? 1 : 0) - (a.nextDate ? 1 : 0) ||
      String(a.nextDate || "9999").localeCompare(String(b.nextDate || "9999")) ||
      String(b.lastDate || "").localeCompare(String(a.lastDate || "")) ||
      b.totalCourses - a.totalCourses,
  );
  return groups;
}

/**
 * 「别处还有」提示：本城搜到了，但别的城市同名的人更多。
 * ⚠ 按**名字去重**计数：按 Coach 记录数算会写出「全国 8 位 · 上海 12」
 * 这种前后矛盾的文案（上海那 12 条记录里大半是同一个人的不同门店）。
 */
async function crossCityHint(keyword, excludeCityId) {
  const rows = await prisma.coach.findMany({
    where: {
      name: { contains: keyword },
      studio: excludeCityId
        ? { status: true, NOT: { cityId: excludeCityId } }
        : { status: true },
    },
    select: { name: true, studio: { select: { city: { select: { id: true, name: true } } } } },
    take: 200,
  });
  const byCity = new Map();
  const names = new Set();
  rows.forEach((r) => {
    const city = r.studio && r.studio.city;
    if (!city) return;
    names.add(r.name);
    let cur = byCity.get(city.id);
    if (!cur) {
      cur = { cityId: city.id, name: city.name, seen: new Set() };
      byCity.set(city.id, cur);
    }
    cur.seen.add(r.name);
  });
  if (!names.size) return null;
  return {
    total: names.size,
    cities: [...byCity.values()]
      .map((c) => ({ cityId: c.cityId, name: c.name, count: c.seen.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

/**
 * 同城搜老师：GET /api/coaches/search?cityId=17&q=kennis
 *
 * ⚠ 同名**不合并**——这是刻意的：
 * 同一个老师在不同门店是两条 Coach 记录（名字一样、id 不同），而我们没有任何
 * 字段能证明「A 店的 Kennis」和「B 店的 Kennis」是同一个人；舞蹈圈重名本来
 * 就常见，跨店授课的也确实有。合并成一个人，用户照着合并结果去约课，很可能
 * 约到另一个人的课 —— 那种错误比多列几行严重得多。
 *
 * 所以这里同城同名**全取**，按名字聚成一组，组内把每家店单独列出来
 * （课程数 + 最近一次 / 下一次排课），是不是同一个人由用户看着门店清单自己判断。
 */
router.get(
  "/search",
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || req.query.keyword || "").trim();
    const cityId = Number(req.query.cityId || 0);
    if (!q) return fail(res, 400, "q 必填");
    // cityId 允许为 0 / 缺省 = 全国（同城 0 命中时也会自动放宽到全国）

    let groups = await buildGroups(await matchCoaches(q, cityId, 120), req.userId);
    // 同城一个都没搜到 → 自动放宽到全国。
    // 老师不像门店那样「就在附近」，用户搜一个名字时并不知道对方在哪个城市；
    // 只回一句「全国还有 N 位」要他再点一次，等于没搜到。
    const nationwide = !groups.length;
    if (nationwide) {
      groups = await buildGroups(await matchCoaches(q, 0, 60), req.userId);
    }

    const result = {
      keyword: q,
      cityId,
      // 全国兜底时结果可能跨城 → 前端要在卡片上标城市
      nationwide,
      groups: groups.slice(0, nationwide ? 12 : 30),
      total: groups.length,
    };

    // 本城搜到了、但别处还有同名的人 → 给一句「全国还有 N 位」和入口。
    // ⚠ 只在同城有结果时提示：同城 0 命中已经放宽成全国了，再提示就是重复。
    if (!nationwide && groups.length) {
      const cc = await crossCityHint(q, cityId);
      if (cc) result.crossCity = cc;
    }

    ok(res, result);
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