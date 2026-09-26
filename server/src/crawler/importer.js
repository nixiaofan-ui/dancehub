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
 * 批量导入
 * @param config 抓取配置（含 studio 引用）
 * @param rows 原始条目，每条需带 _date（Date 类型）；可带 _studioName 覆盖默认 studio
 * @returns {{ studios, created, updated, skipped, total }} 汇总（多门店时按门店细分）
 */
export async function importSchedules(config, rows) {
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

  for (const [studioName, groupRows] of groups) {
    // iWOD 系店铺的约课小程序 appId → Studio.bookingMiniAppId（预约跳转用）
    const extra = {};
    if (config.http && config.http.appId) extra.bookingMiniAppId = config.http.appId;
    // 多门店配置（如 JustJerk 两个校区各自一个官网页）可在条目级覆盖
    // 城市/官网/平台，优先级高于 config.studio
    const rowOverride = {};
    for (const key of ["_officialUrl", "_platform", "_address"]) {
      const v = groupRows.find((r) => r[key])?.[key];
      if (v) rowOverride[key] = v;
    }
    const studioRef = {
      ...config.studio,
      name: studioName,
      ...(rowOverride._officialUrl ? { officialUrl: rowOverride._officialUrl } : {}),
      ...(rowOverride._platform ? { platform: rowOverride._platform } : {}),
      ...(rowOverride._address ? { address: rowOverride._address } : {}),
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
      const res = await upsertSchedule(entry);
      if (res.action === "created") created[studioName] = (created[studioName] || 0) + 1;
      else updated[studioName] = (updated[studioName] || 0) + 1;
    }
  }

  await invalidateTimelineCache();
  return {
    studios: [...groups.keys()],
    created,
    updated,
    skipped,
    total: rows.length,
  };
}
