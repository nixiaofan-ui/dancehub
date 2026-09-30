/**
 * 批量导入：把映射后的条目写入数据库
 * - studio / coach 按名称幂等（存在即复用，不存在则创建）
 * - schedule 按「studio + date + courseName + startTime」upsert（存在则更新）
 */
import { prisma } from "../lib/prisma.js";
import { canonStudioName } from "../lib/dedupe-studios.js";
import { collapseGroup, courseKey } from "../lib/dedupe-schedules.js";
import { invalidateTimelineCache } from "../services/schedule.service.js";
import { invalidateStudioIndex } from "../lib/studio-index.js";
import { mapRawToSchedule } from "./mapper.js";

/** 按地区+名称幂等创建城市（全国扩展：新城市自动建） */
export async function findOrCreateCity(region, name) {
  const existing = await prisma.city.findFirst({
    where: { region: region || "CN", name: name || "上海" },
  });
  if (existing) return existing;
  return prisma.city.create({
    data: { region: region || "CN", name: name || "上海" },
  });
}

/**
 * 平台类型兜底：配置没写 platform 时按地区推断。
 * 海外场馆一律不是微信小程序 —— 若标成 WECHAT，前端会把用户引导去
 * 「微信搜索该舞室官方小程序」，韩国舞室根本没有，是错误引导。
 */
function resolvePlatform(studioRef) {
  if (studioRef.platform) return studioRef.platform;
  return studioRef.region === "OVERSEAS" ? "OTHER" : "WECHAT";
}

export async function findOrCreateStudio(studioRef, extra = {}) {
  const existing = await resolveExistingStudio(studioRef);
  // 跳转小程序 appId / 官网地址等新字段：已有店也补写
  // （只在新值非空且不同才更新，减少无谓写入）
  const patch = {};
  if (!existing) {
    const city = await findOrCreateCity(studioRef.region, studioRef.city);
    return createStudioOnce(studioRef, extra, city);
  }

  if (extra.bookingMiniAppId && existing.bookingMiniAppId !== extra.bookingMiniAppId) {
    patch.bookingMiniAppId = extra.bookingMiniAppId;
  }
  if (studioRef.officialUrl && existing.officialUrl !== studioRef.officialUrl) {
    patch.officialUrl = studioRef.officialUrl;
  }
  // 已入库的海外店可能是在 platform 兜底逻辑加上之前建的，被标成了 WECHAT，
  // 这里一并纠正（只纠正海外店，国内店的 platform 以库里为准）
  const wantPlatform = resolvePlatform(studioRef);
  if (
    studioRef.region === "OVERSEAS" &&
    existing.platform === "WECHAT" &&
    wantPlatform !== "WECHAT"
  ) {
    patch.platform = wantPlatform;
  }
  if (studioRef.address && !existing.address) patch.address = studioRef.address;

  if (Object.keys(patch).length) {
    return prisma.studio.update({ where: { id: existing.id }, data: patch });
  }
  return existing;
}

/**
 * 找「已经存在的同一家店」。
 *
 * 第一优先：店名完全一致（历史行为，绝大多数配置都命中这条）。
 * 兜底：同城 + **归一化同名**（只留字母数字汉字并去掉「市」）。
 *
 * 为什么需要兜底：配置生成器早期有「取的市字多一位」的 bug，同一个 iWOD box
 * 被两个脚本扫到时生成了「D-DAY 舞蹈（市秦淮）」和「D-DAY 舞蹈（秦淮）」两个名字，
 * 精确匹配落空 → 又建了一条门店，于是用户在对比页看到两家同名门店，
 * 课表是两个库的并集（同屏出现上游根本没有的课）。这 105 个「（市XX）」店名
 * 就是这么来的（2026-09-29 老板在南京 D-DAY 发现）。
 *
 * ⚠ 只复用、**不改名**：改名会让历史数据与配置再次对不上（G-STEPS 城市校准
 * 那次踩过：只改 cityId 不改名 → 下一轮抓取又建一条空壳店）。
 */
async function resolveExistingStudio(studioRef) {
  const name = String(studioRef.name || "").trim();
  if (!name) return null;

  // ① 同名且可见
  const exact = await prisma.studio.findFirst({ where: { name, status: true } });
  if (exact) return exact;

  const city = await findOrCreateCity(studioRef.region, studioRef.city);
  const siblings = await prisma.studio.findMany({
    where: { cityId: city.id },
    select: { id: true, name: true, status: true },
  });
  const want = canonStudioName(name);
  const sameCanon = siblings.filter((s) => canonStudioName(s.name) === want);

  // ② 归一化同名且可见 —— 最常见的就是「（市秦淮）」撞上「（秦淮）」
  const visible = sameCanon.find((s) => s.status);
  if (visible) {
    if (visible.name !== name) {
      console.warn(
        `[importer] 「${name}」与库内 #${visible.id}「${visible.name}」视为同一家店，复用而非新建`,
      );
    }
    return visible;
  }

  // ③ 只剩被隐藏的记录（上一轮 dedupe 合并掉的重复项）→ 复用，别新建第三条。
  //    这里不再把它改回可见：同城已经没有其他可见的同族门店，说明它自己才是活的，
  //    dedupe 只会在「有可见的同族门店」时才隐藏东西，所以这里唤醒是安全的；
  //    反之（有可见同族）已经在上一步返回了，不会出现两条互相唤醒来回翻的状态。
  const hidden = sameCanon.find((s) => s.name === name) || sameCanon[0];
  if (hidden) {
    await prisma.studio
      .update({ where: { id: hidden.id }, data: { status: true } })
      .catch(() => {});
    console.warn(`[importer] 「${name}」复用此前被合并隐藏的 #${hidden.id}，已重新置为可见`);
    return hidden;
  }
  return null;
}

/**
 * 建店 —— 并且保证「同一家店只会留下一条」。
 *
 * 并发场景：新配置上线的瞬间，新旧两个容器实例都会补跑同一份配置，
 * 两边 findFirst 都说「没有这家店」→ 各插一条同名记录（2026-09-29 抓到 8 组，
 * 时间戳精确到同一秒）。这里在 create 之后复查一次同名记录：谁 id 大谁把自己
 * 撤掉，两边结论一致，结果是幂等的。
 */
async function createStudioOnce(studioRef, extra, city) {
  const created = await prisma.studio.create({
    data: {
      name: studioRef.name,
      cityId: city.id,
      address: studioRef.address || null,
      platform: resolvePlatform(studioRef),
      status: true,
      bookingMiniAppId: extra.bookingMiniAppId || null,
      officialUrl: studioRef.officialUrl || null,
    },
  });
  // 搜得到的前提是索引里有它 —— 新接入的舞室不能等 10 分钟 TTL
  invalidateStudioIndex();

  const twins = await prisma.studio.findMany({
    where: { cityId: city.id, name: studioRef.name },
    select: { id: true },
  });
  if (twins.length < 2) return created;

  const keepId = Math.min(...twins.map((t) => t.id));
  if (keepId === created.id) return created;

  // 只在「这条新记录还没挂任何数据」时撤掉它，避免删掉刚写进去的课
  const [schedules, coaches, follows] = await Promise.all([
    prisma.schedule.count({ where: { studioId: created.id } }),
    prisma.coach.count({ where: { studioId: created.id } }),
    prisma.follow.count({ where: { studioId: created.id } }),
  ]);
  if (schedules || coaches || follows) return created;

  await prisma.studio.delete({ where: { id: created.id } }).catch(() => {});
  const kept = await prisma.studio.findUnique({ where: { id: keepId } });
  if (kept) {
    console.warn(`[importer] 并发建店：撤掉重复的 #${created.id}，复用 #${kept.id}「${kept.name}」`);
  }
  return kept || created;
}

export async function findOrCreateCoach(studioId, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const existing = await prisma.coach.findFirst({ where: { studioId, name: trimmed } });
  if (existing) return existing;
  return prisma.coach.create({ data: { studioId, name: trimmed } });
}

/**
 * 更新时「上游没给」的字段保留库里的旧值，不要拿 null 去覆盖。
 *
 * 为什么必须这样：`update({ data: entry })` 是全量覆写，而 entry 里
 * bookedNum / coursePicUrl 是「这次抓不到就为 null」的软字段 ——
 * 平台偶发不返回（接口抖一下、字段被改版）时，库里已经拿到的真实人数
 * 和封面图会被一次性擦掉，用户看到的就是「没有数字」且再也回不来
 * （下一轮抓取如果又正常，才可能补回）。
 *
 * 注意只保护**软字段**：课名、时间、教练这些是权威字段，上游说变就是变了。
 */
function keepOldOnMissing(entry, existing) {
  const patch = { ...entry };
  if (patch.bookedNum == null && existing.bookedNum != null) {
    patch.bookedNum = existing.bookedNum;
  }
  if (!patch.coursePicUrl && existing.coursePicUrl) {
    patch.coursePicUrl = existing.coursePicUrl;
  }
  return patch;
}

export async function upsertSchedule(entry) {
  const eh = entry.startTime.getUTCHours();
  const em = entry.startTime.getUTCMinutes();
  const sameSlot = (c) =>
    c.startTime.getUTCHours() === eh && c.startTime.getUTCMinutes() === em;

  // ① 精确匹配（绝大多数情况）。@db.Time 列过滤在 Prisma/MySQL 下不可靠，
  //    改为按日期+课程拉取后 JS 比对 UTC 时分。
  const candidates = await prisma.schedule.findMany({
    where: {
      studioId: entry.studioId,
      scheduleDate: entry.scheduleDate,
      courseName: entry.courseName,
    },
  });
  let matched = candidates.filter(sameSlot);

  // ② 精确匹配落空 → 用「归一化课名」在本店本日再找一遍。
  //    上游把课名从 `古典舞（望明月）` 改成 `古典舞(望明月)`（全角括号→半角），
  //    或把 `Jazz 入门` 的空格去掉时，精确匹配必然落空；若不做这一步，
  //    每轮抓取都会新建一条、pruneVanished 再把旧那条删掉 —— 同一节课的 id 天天变，
  //    挂在旧 id 上的用户预约/提醒也跟着一起没。归一化口径必须与
  //    dedupe-schedules 的 courseKey 完全一致（NFKC + 去标点），否则两边会互相打架。
  if (!matched.length) {
    const dayRows = await prisma.schedule.findMany({
      where: {
        studioId: entry.studioId,
        scheduleDate: entry.scheduleDate,
        ownerId: null, // 用户手录的课不认领
      },
    });
    const want = courseKey(entry.courseName);
    matched = dayRows.filter((c) => courseKey(c.courseName) === want && sameSlot(c));
  }

  if (matched.length === 1) {
    const existing = matched[0];
    await prisma.schedule.update({
      where: { id: existing.id },
      data: keepOldOnMissing(entry, existing),
    });
    return { action: "updated", id: existing.id };
  }

  if (matched.length > 1) {
    // 库里这一节已经是重复状态（历史遗留，或本轮并发刚各插了一条）：
    // 就地合并成一条再更新，别让它继续以两条的形态留在课表上。
    const { keepId } = await collapseGroup(matched);
    const keep = matched.find((m) => m.id === keepId) || matched[0];
    await prisma.schedule.update({
      where: { id: keep.id },
      data: keepOldOnMissing(entry, keep),
    });
    return { action: "updated", id: keep.id, merged: matched.length - 1 };
  }

  const created = await prisma.schedule.create({ data: entry });
  return { action: "created", id: created.id };
}

/**
 * 幂等键：与 upsertSchedule 的匹配口径保持一致（门店 + 日期 + 课名 + 开始时分）。
 * 用「课程指纹」而不是自增 id 来记「本轮抓到过什么」，
 * 这样即使 upsert 中途跳过了某条，也不会把库里那节课误判成已消失。
 */
function fingerprint(studioId, scheduleDate, courseName, startTime) {
  const day = scheduleDate.toISOString().slice(0, 10);
  const hh = String(startTime.getUTCHours()).padStart(2, "0");
  const mm = String(startTime.getUTCMinutes()).padStart(2, "0");
  return `${studioId}|${day}|${courseName}|${hh}:${mm}`;
}

/**
 * 清理「上游已经没有了、但库里还留着」的课。
 *
 * 为什么必须清：抓取一直只做 upsert，从不删除。舞室改课表（换老师、改课名、
 * 直接把课挪走）之后，旧记录会永远留在库里。2026-09-29 实测 MAX POWER 陆家嘴店
 * 9/29 12:00 这个时段：上游只有 1 节课，我们库里挤了 6 节 —— 用户点进去看课表，
 * 多出来那 5 节在官方的约课系统里根本约不到，比没接还糟。
 *
 * 判定范围严格收窄，只动「本轮确实抓到过课的 门店+日期」：
 *   - 本轮该门店该日期一节课都没抓到 → 整组跳过（接口抽风返回空时不会清库）
 *   - 用户手录的课（ownerId 非空）→ 永远不碰
 *   - 有预约 / 有提醒的课 → 保留（删了会连带删掉用户自己的记录）
 *   - 骤减保护：库里有 8 节以上而本轮只抓到不足三成 → 疑似平台改版/分页没翻完，
 *     跳过并告警，宁可留脏数据也不做批量误删
 *
 * @returns {Promise<{ pruned: number, groups: number, skippedGroups: string[] }>}
 */
async function pruneVanished(seen) {
  // 应急开关：CRAWL_PRUNE=0 可整体关掉清理（默认开）。
  // 万一某个平台的接口悄悄改了分页/字段，导致抓到的课骤减，不用回滚代码就能先止血。
  if (String(process.env.CRAWL_PRUNE ?? "1") === "0") {
    return { pruned: 0, groups: 0, skippedGroups: ["已通过 CRAWL_PRUNE=0 关闭"] };
  }

  // 门店 → 本轮抓到过课的日期集合
  const byStudio = new Map();
  for (const key of seen.keys()) {
    const [sid, day] = key.split("|");
    if (!byStudio.has(sid)) byStudio.set(sid, new Set());
    byStudio.get(sid).add(day);
  }

  let pruned = 0;
  let groups = 0;
  const skippedGroups = [];

  for (const [sid, days] of byStudio) {
    const studioId = Number(sid);
    const dates = [...days].map((d) => new Date(`${d}T00:00:00Z`));
    const existing = await prisma.schedule.findMany({
      where: { studioId, ownerId: null, scheduleDate: { in: dates } },
      select: { id: true, courseName: true, scheduleDate: true, startTime: true },
    });
    if (!existing.length) continue;

    // 逐天判断，避免某天数据异常连累同店其他日期
    for (const day of days) {
      const date = new Date(`${day}T00:00:00Z`);
      const sameDay = existing.filter(
        (e) => e.scheduleDate.toISOString().slice(0, 10) === day,
      );
      const kept = sameDay.filter((e) =>
        seen.has(fingerprint(studioId, date, e.courseName, e.startTime)),
      );
      const stale = sameDay.filter((e) => !kept.includes(e));
      if (!stale.length) continue;
      if (sameDay.length >= 8 && kept.length < sameDay.length * 0.3) {
        skippedGroups.push(`${studioId}@${day} 库里${sameDay.length}节仅存活${kept.length}节`);
        continue;
      }

      const res = await prisma.schedule.deleteMany({
        where: {
          id: { in: stale.map((e) => e.id) },
          ownerId: null,
          bookings: { none: {} },
          reminders: { none: {} },
        },
      });
      pruned += res.count;
      groups += 1;
    }
  }

  if (skippedGroups.length) {
    console.warn(
      `[importer] 骤减保护触发，跳过 ${skippedGroups.length} 组清理：${skippedGroups.slice(0, 5).join("；")}`,
    );
  }
  return { pruned, groups, skippedGroups };
}

/**
 * 批量导入
 * @param config 抓取配置（含 studio 引用）
 * @param rows 原始条目，每条需带 _date（Date 类型）；可带 _studioName 覆盖默认 studio
 * @returns {{ studios, created, updated, skipped, total, pruned }} 汇总（多门店时按门店细分）
 */
export async function importSchedules(config, rows, ensureStudios = []) {
  /**
   * 建店用的档案。⚠ address 是**配置顶层**字段，不在 config.studio 里 ——
   * 早期只展开 config.studio（name/city/region），于是配置里那 1100 条真地址
   * 一条都没进库（库里地址覆盖率常年只有 14%），区名和坐标全都抽不出来。
   */
  const baseRef = {
    ...config.studio,
    ...(config.address ? { address: config.address } : {}),
  };

  /**
   * 只要建店、不排课的门店。
   * 有的平台（嘉禾）课表接口只返回「今天有课」的门店，当天没排课的分店
   * 会整个从库里消失 —— 用户翻列表时以为没接入。档案接口能拿到全量门店，
   * 这里先把它们建出来，课为 0 也留一条记录。
   */
  for (const ref of ensureStudios) {
    if (!ref || !ref.name) continue;
    try {
      const studioRef = {
        ...baseRef,
        name: ref.name,
        ...(ref.city ? { city: ref.city } : {}),
        // 上游实时拿到的地址比配置里写死的准优先
        ...(ref.address ? { address: ref.address } : {}),
      };
      await findOrCreateStudio(studioRef, {
        bookingMiniAppId: config.http?.appId || config.aiwugong?.host,
      });
    } catch (e) {
      console.warn("[importer] 建店失败:", ref && ref.name, e.message);
    }
  }

  // 按门店分组（http 模式的分店用 _studioName，缺省回落到 config.studio.name）
  const groups = new Map();
  for (const row of rows) {
    const studioName = (row._studioName || "").trim() || config.studio.name;
    if (!groups.has(studioName)) groups.set(studioName, []);
    groups.get(studioName).push(row);
  }

  const created = {};
  const updated = {};
  let skipped = 0;
  /** 本轮抓到过的课程指纹，供 pruneVanished 判断哪些课已经在上游消失 */
  const seen = new Set();

  for (const [studioName, groupRows] of groups) {
    // iWOD / 爱舞功系店铺的约课小程序 appId → Studio.bookingMiniAppId（预约跳转用）
    const extra = {};
    const bookingAppId = config.http?.appId || config.aiwugong?.host;
    if (bookingAppId) extra.bookingMiniAppId = bookingAppId;
    // 多门店配置（如 JustJerk 两个校区各自一个官网页）可在条目级覆盖
    // 城市/官网/平台，优先级高于 config.studio
    const rowOverride = {};
    for (const key of ["_officialUrl", "_platform", "_address", "_city"]) {
      const v = groupRows.find((r) => r[key])?.[key];
      if (v) rowOverride[key] = v;
    }
    const studioRef = {
      ...baseRef,
      name: studioName,
      ...(rowOverride._officialUrl ? { officialUrl: rowOverride._officialUrl } : {}),
      ...(rowOverride._platform ? { platform: rowOverride._platform } : {}),
      ...(rowOverride._address ? { address: rowOverride._address } : {}),
      // 跨城市连锁（如嘉禾舞社：北京/广州/青岛/天津/邯郸）按门店地址覆盖城市
      ...(rowOverride._city ? { city: rowOverride._city } : {}),
    };
    const studio = await findOrCreateStudio(studioRef, extra);
    for (const row of groupRows) {
      const coach = await findOrCreateCoach(studio.id, row.coach);
      const entry = mapRawToSchedule(row, {
        studioId: studio.id,
        coachId: coach ? coach.id : null,
        date: row._date,
      });
      if (!entry.courseName || !entry.scheduleDate || !entry.startTime || !entry.endTime) {
        skipped += 1;
        continue;
      }
      seen.add(fingerprint(studio.id, entry.scheduleDate, entry.courseName, entry.startTime));
      const res = await upsertSchedule(entry);
      if (res.action === "created") created[studioName] = (created[studioName] || 0) + 1;
      else updated[studioName] = (updated[studioName] || 0) + 1;
    }
  }

  // 先按「本轮看到的课」清理幽灵课，再失效时间轴缓存（顺序反了会把旧数据缓存进去）
  const prune = await pruneVanished(seen);

  await invalidateTimelineCache();
  return {
    studios: [...groups.keys()],
    created,
    updated,
    skipped,
    pruned: prune.pruned,
    total: rows.length,
  };
}
