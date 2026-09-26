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

export async function findOrCreateStudio(studioRef, extra = {}) {
  const existing = await prisma.studio.findFirst({ where: { name: studioRef.name } });
  // 跳转小程序 appId 等新字段：已有店也补写（只在新值非空且不同才更新，减少无谓写入）
  const patch = {};
  if (extra.bookingMiniAppId && existing && existing.bookingMiniAppId !== extra.bookingMiniAppId) {
    patch.bookingMiniAppId = extra.bookingMiniAppId;
  }
  if (Object.keys(patch).length) {
    return prisma.studio.update({ where: { id: existing.id }, data: patch });
  }
  if (existing) return existing;

  const city = await findOrCreateCity(studioRef.region, studioRef.city);
  return prisma.studio.create({
    data: {
      name: studioRef.name,
      cityId: city.id,
      platform: "WECHAT",
      status: true,
      bookingMiniAppId: extra.bookingMiniAppId || null,
    },
  });
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
    const studio = await findOrCreateStudio({ ...config.studio, name: studioName }, extra);
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
