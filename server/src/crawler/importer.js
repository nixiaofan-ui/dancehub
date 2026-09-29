/**
 * 批量导入：把映射后的条目写入数据库
 * - studio / coach 按名称幂等（存在即复用，不存在则创建）
 * - schedule 按「studio + date + courseName + startTime」upsert（存在则更新）
 */
import { prisma } from "../lib/prisma.js";
import { invalidateTimelineCache } from "../services/schedule.service.js";
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
  const existing = await prisma.studio.findFirst({ where: { name: studioRef.name } });
  // 跳转小程序 appId / 官网地址等新字段：已有店也补写
  // （只在新值非空且不同才更新，减少无谓写入）
  const patch = {};
  if (!existing) {
    const city = await findOrCreateCity(studioRef.region, studioRef.city);
    return prisma.studio.create({
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

export async function findOrCreateCoach(studioId, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const existing = await prisma.coach.findFirst({ where: { studioId, name: trimmed } });
  if (existing) return existing;
  return prisma.coach.create({ data: { studioId, name: trimmed } });
}

export async function upsertSchedule(entry) {
  // @db.Time 列过滤在 Prisma/MySQL 下不可靠，改为按日期+课程拉取后 JS 比对 UTC 时分
  const candidates = await prisma.schedule.findMany({
    where: {
      studioId: entry.studioId,
      scheduleDate: entry.scheduleDate,
      courseName: entry.courseName,
    },
  });
  const eh = entry.startTime.getUTCHours();
  const em = entry.startTime.getUTCMinutes();
  const existing = candidates.find(
    (c) => c.startTime.getUTCHours() === eh && c.startTime.getUTCMinutes() === em,
  );
  if (existing) {
    await prisma.schedule.update({ where: { id: existing.id }, data: entry });
    return { action: "updated", id: existing.id };
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
   * 只要建店、不排课的门店。
   * 有的平台（嘉禾）课表接口只返回「今天有课」的门店，当天没排课的分店
   * 会整个从库里消失 —— 用户翻列表时以为没接入。档案接口能拿到全量门店，
   * 这里先把它们建出来，课为 0 也留一条记录。
   */
  for (const ref of ensureStudios) {
    if (!ref || !ref.name) continue;
    try {
      const studioRef = {
        ...config.studio,
        name: ref.name,
        ...(ref.city ? { city: ref.city } : {}),
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
      ...config.studio,
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
