import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { toDateKey, parseDateKey, visibleScope } from "../services/schedule.service.js";
import { pickStyles } from "../services/dance-style.service.js";
import { buildStyleMap } from "../services/studio-style.service.js";
import { sortStudiosByName } from "../services/studio-sort.service.js";
import { assignBrands, brandKey, cleanBrandLabel } from "../lib/studio-name.js";
import { searchStudioIdsByNorm, normName, invalidateStudioIndex } from "../lib/studio-index.js";

const router = Router();

/**
 * 归一化：只留字母 / 数字 / 汉字，统一小写。
 *
 * 用户吐槽过「搜 Goldenbelt 搜不到」—— 库里那家叫「Golden belt 街舞厂牌」，
 * 中间有个空格，而 DB 侧是严格的 `contains` 子串匹配，多一个空格就整个失配。
 * 同样的问题也出在 `ADZ Dance Studio` / `ADZDanceStudio`、`GH5 Dance Studio` / `GH5`。
 * 这类「连写 vs 分开写」的差异在舞蹈行业名字里非常常见，必须容忍。
 */
/**
 * 搜索归一化。**必须与索引侧的 `normName` 是同一个函数** —— needle 在
 * 索引串上比对，两边算法只要差一点（比如一边留连字符一边不留），
 * `trex` 就永远匹配不上 `trexdance`。曾经这里是一份独立拷贝，
 * 改了一边漏了另一边，直接导致「必须打连字符才搜得到」。
 */
const normFuzzy = normName;

/**
 * 品牌尾巴。用户习惯搜全名（`GH5DanceStudio`、`BodySoul DanceStudio`、
 * `ADZ舞蹈工作室`），而库里的店名是「品牌 + 分店/区名」（`GH5·中山公园店（长宁）`）——
 * 顺序不一致，光靠归一化也匹配不上，得先把通名后缀剥掉只留品牌本体。
 */
/**
 * 精确命中几条以内时，仍然补跑一次松匹配（只追加不替换）。
 * 定 2 是为了避开「舞蹈」「街舞」这类泛词——它们精确命中成百上千条，
 * 本来就该走精确路径，补跑松匹配只是白烧一次 CPU。
 */
const FUZZY_SUPPLEMENT_MAX = 2;

const GENERIC_TAILS = [
  "dancestudio", "streetdance", "hiphopstudio", "studio", "dance", "club",
  "danceschool", "街舞工作室", "舞蹈工作室", "舞蹈艺术中心", "流行舞", "培训中心",
  "舞蹈中心", "工作室", "街舞", "舞蹈", "舞室", "舞社", "舞房",
];

/**
 * 生成搜索变体：原文 + 反复剥尾巴后的品牌本体。
 * 只在外层严格匹配全落空时才用，所以短串误命中的风险很低。
 * @returns {string[]} 去重后由短到长排序
 */
function fuzzyVariants(keyword) {
  const out = new Set([normFuzzy(keyword)]);
  const tails = [...GENERIC_TAILS].sort((a, b) => b.length - a.length);
  let queue = [...out];
  let guard = 0;
  while (queue.length && guard++ < 10) {
    const cur = queue.pop();
    for (const t of tails) {
      if (cur.length > t.length + 1 && cur.endsWith(t)) {
        const stripped = cur.slice(0, -t.length);
        // 别把剥得过短的通用词（如「舞」）当品牌去搜，会撞出一堆不相干的店
        if (stripped.length >= 2 && !GENERIC_TAILS.includes(stripped) && !out.has(stripped)) {
          out.add(stripped);
          queue.push(stripped);
        }
      }
    }
  }
  return [...out].sort((a, b) => a.length - b.length);
}

/**
 * 松匹配兜底：精确 contains 查不到时，用关键词的前缀捞出候选，再按归一化串比对。
 *
 * 为什么要「先取前缀候选、再 JS 过滤」两步？因为 DB 侧没法直接表达
 * 「忽略所有空格连接后再 contains」（那要 REPLACE 原生 SQL，Prisma 里不划算，
 * 还会锁死数据库方言）。前缀探针会把 `Golden belt 街舞厂牌` 捞进候选池，
 * 剩下的交给 JS 判。探针前缀从长到短试，命中即停。
 */
async function fuzzySearchStudio(keyword, baseWhere, includeArg) {
  const needles = fuzzyVariants(keyword);
  if (!needles.length || !needles[0]) return [];

  // ① 归一化内存索引优先。
  //    这是唯一能处理「原串里被标点切断」的路径：`t-rex dance` 归一化成 `trexdance`，
  //    下面那些探针前缀是从归一化串上截的，拿去 DB contains 原始店名永远落空
  //    （`tre` 在 `t-rex dance` 里不是一个连续子串）—— 用户搜 `trex` 得到 0 结果。
  const indexed = await searchStudioIdsByNorm(needles, {
    cityId: baseWhere.cityId,
    onlyActive: baseWhere.status === true,
  });
  if (indexed.length) {
    const rows = await prisma.studio.findMany({
      where: { ...baseWhere, id: { in: indexed } },
      include: includeArg,
    });
    // ⚠ `id: { in: [...] }` 不保证按给的顺序回（MySQL 是按主键扫的），
    //   不重排的话索引辛苦算出来的「前缀命中优先、长 needle 优先」全白费，
    //   最相关的那家可能被排到最后几十条里。
    const rank = new Map(indexed.map((id, i) => [id, i]));
    return rows.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }

  // ② 索引没命中（多为索引尚未刷新到最新门店）→ 回退到前缀探针
  // 探针前缀优先用剥过尾巴的短变体 —— 拿原串的前缀（"gh5da"）去探候选是捞不到的
  const probes = [];
  for (const root of needles) {
    for (const n of [8, 6, 4, 3, 2]) {
      if (root.length > n && !probes.includes(root.slice(0, n))) probes.push(root.slice(0, n));
    }
  }

  for (const probe of probes) {
    const cand = await prisma.studio.findMany({
      where: { ...baseWhere, OR: [{ name: { contains: probe } }, { address: { contains: probe } }] },
      take: 500,
      include: includeArg,
    });
    const hit = cand.filter((s) => {
      const nm = normFuzzy(s.name);
      const ad = normFuzzy(s.address);
      return needles.some(
        (nd) =>
          nm.includes(nd) ||
          ad.includes(nd) ||
          // 反向：用户把全名打全了（`GH5舞蹈 中山公园店`），库里反而只有品牌名。
          // 只在库名够长时才认，避免「舞」这种一字 needle 反查到半个库。
          (nm.length >= 4 && nd.includes(nm))
      );
    });
    if (hit.length) return hit;
  }
  return [];
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { cityId, keyword, includeInactive } = req.query;
    const baseWhere = {};
    // 停用的舞室默认不出现在发现页；管理端可传 includeInactive=1 查看全部
    if (includeInactive !== "1") baseWhere.status = true;
    if (cityId) baseWhere.cityId = Number(cityId);
    const where = keyword
      ? { ...baseWhere, OR: [{ name: { contains: keyword } }, { address: { contains: keyword } }] }
      : { ...baseWhere };
    // 不带 cityId = 跨城全局搜索。此时必须限量：像「舞蹈」这种泛词会命中上千家，
    // 全量回包既慢又把真正想找的那家埋掉。默认 200 条，前端可传 limit 覆盖。
    const limit = cityId ? undefined : Math.min(Number(req.query.limit) || 200, 500);

    const includeArg = { city: true, _count: { select: { schedules: true, coaches: true } } };
    let studios = await prisma.studio.findMany({
      where,
      ...(limit ? { take: limit } : {}),
      include: includeArg,
    });

    // 精确匹配颗粒无收时再走松匹配（正常路径零额外开销）
    let fuzzyApplied = false;
    if (keyword && studios.length === 0) {
      studios = await fuzzySearchStudio(String(keyword), baseWhere, includeArg);
      fuzzyApplied = studios.length > 0;
    } else if (
      // 精确命中「太少」时也要补一次：DB 的 contains 只认原串，
      // `trex` 在 `t-rex dance` 里根本不连续，而只要库里有**另一家**名字里
      // 恰好含这个子串的店，精确路径就返回非空 → 松匹配被整段跳过，
      // 结果就是「能搜到，但搜出来的不是你要的那家」。
      // 只补不替换：精确命中的店不会因此消失（最终顺序由下面的
      // sortStudiosByName 统一排，这里不管先后）。
      keyword &&
      studios.length <= FUZZY_SUPPLEMENT_MAX &&
      normFuzzy(String(keyword)).length >= 3
    ) {
      const extra = await fuzzySearchStudio(String(keyword), baseWhere, includeArg);
      const seen = new Set(studios.map((s) => s.id));
      const add = extra.filter((s) => !seen.has(s.id));
      if (add.length) {
        studios = studios.concat(add);
        fuzzyApplied = true;
      }
    }

    // 同城搜不到 → 查一次全国，只回提示不外城门店。
    // 「杭州搜 T-rex 什么都搜不到」多半不是没这家店，而是它在别的城市
    // （t-rex dance 实际挂在北京）。不直接把外城结果塞进列表，是因为同城页
    // 突然冒出「北京 XX」会让人以为定位错了；给用户一句话 + 一键放开城市限定更稳。
    let crossCity = null;
    if (keyword && cityId && studios.length === 0) {
      const all = await fuzzySearchStudio(
        String(keyword),
        { status: baseWhere.status },
        includeArg,
      );
      if (all.length) {
        const byCity = new Map();
        for (const s of all) byCity.set(s.cityId, (byCity.get(s.cityId) || 0) + 1);
        const cities = await prisma.city.findMany({ where: { id: { in: [...byCity.keys()] } } });
        crossCity = {
          total: all.length,
          cities: cities
            .map((c) => ({ cityId: c.id, name: c.name, count: byCity.get(c.id) || 0 }))
            .filter((c) => c.count)
            .sort((a, b) => b.count - a.count),
        };
      }
    }

    const styleMap = await buildStyleMap(studios.map((s) => s.id));
    // 按名称首字母排序（中文走拼音），并给每家带上分组字母，供发现页右侧索引条定位
    const list = sortStudiosByName(studios).map((s) => ({
      ...s,
      styles: styleMap.get(s.id) || [],
    }));

    // 全局搜索额外回「每个城市命中几家」，前端拿它渲染顶部城市筛选条
    // （结果被 limit 截断过，计数必须单独 groupBy，不能从 list 里数）
    if (req.query.withCityCounts === "1") {
      // 松匹配之后 where 里那串 keyword OR 已经不再是最终结果的口径，
      // 必须按真正命中的 id 来算，否则城市计数和列表会对不上
      const countWhere = fuzzyApplied
        ? { ...baseWhere, id: { in: studios.map((s) => s.id) } }
        : where;
      const groups = await prisma.studio.groupBy({
        by: ["cityId"],
        where: countWhere,
        _count: { _all: true },
      });
      const cities = await prisma.city.findMany({
        where: { id: { in: groups.map((g) => g.cityId) } },
      });
      const nameById = new Map(cities.map((c) => [c.id, c.name]));
      const cityCounts = groups
        .map((g) => ({
          cityId: g.cityId,
          name: nameById.get(g.cityId) || "",
          count: g._count._all,
        }))
        .filter((c) => c.name)
        .sort((a, b) => b.count - a.count);
      return ok(res, { items: list, cityCounts, total: cityCounts.reduce((n, c) => n + c.count, 0) });
    }

    // 有跨城兜底时回对象（前端 Array.isArray 判断那条路会走到 res.items）
    if (crossCity) return ok(res, { items: list, crossCity });
    ok(res, list);
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

    // 品牌归属统一交给 assignBrands：分隔符、连写、总店全名三条路合一。
    // 之前分两轮（先拆分隔符、剩下的才聚类）会漏掉总店 —— 「猫宁舞蹈工作室」
    // 自己没有分隔符也切不出分店后缀，永远进不了品牌，兄弟店就成了单店。
    const assigned = assignBrands(studios);

    // 按归一 key 聚合（去空格+小写），展示名取出现最多的写法，
    // 免得「AB DANCE」和「Ab Dance」算成两个品牌
    const map = new Map(); // normKey -> { label, labels: Map, stores: [] }
    for (const s of studios) {
      const hit = assigned.get(s.id);
      if (!hit) continue;
      const key = brandKey(hit.brand);
      if (!map.has(key)) map.set(key, { label: hit.brand, labels: new Map(), stores: [] });
      const g = map.get(key);
      g.labels.set(hit.brand, (g.labels.get(hit.brand) || 0) + 1);
      g.stores.push({ id: s.id, name: s.name, branch: hit.branch });
      // 展示名用出现次数最多的写法
      g.label = cleanBrandLabel([...g.labels.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }

    const brands = [...map.values()]
      .filter((g) => g.stores.length >= 2)
      .map((g) => ({
        name: g.label,
        storeCount: g.stores.length,
        stores: g.stores.slice().sort((a, b) => a.branch.localeCompare(b.branch, "zh")),
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
    // 搜索索引有 10 分钟 TTL，不失效的话刚建/刚补录的门店要等 TTL 才搜得到
    invalidateStudioIndex();
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