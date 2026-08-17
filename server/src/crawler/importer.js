/**
 * 批量导入：把映射后的条目写入数据库
 * - studio / coach 按名称幂等（存在即复用，不存在则创建）
 * - schedule 按「studio + date + courseName + startTime」upsert（存在则更新）
 */
import { prisma } from "../lib/prisma.js";
import { invalidateTimelineCache } from "../services/schedule.service.js";
import { mapRawToSchedule } from "./mapper.js";

export async function findOrCreateStudio(studioRef) {
  const existing = await prisma.studio.findFirst({ where: { name: studioRef.name } });
  if (existing) return existing;

  const city = await prisma.city.findFirst({
    where: { region: studioRef.region, name: studioRef.city },
  });
  return prisma.studio.create({
    data: {
      name: studioRef.name,
      cityId: city ? city.id : 1,
      platform: "WECHAT",
      status: true,
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
 * @param rows 原始条目，每条需带 _date（Date 类型）
 * @returns {{ studioId, studioName, created, updated, skipped, total }}
 */
export async function importSchedules(config, rows) {
  const studio = await findOrCreateStudio(config.studio);
  const stats = { studioId: studio.id, studioName: studio.name, created: 0, updated: 0, skipped: 0, total: rows.length };

  for (const row of rows) {
    const coach = await findOrCreateCoach(studio.id, row.coach);
    const entry = mapRawToSchedule(row, {
      studioId: studio.id,
      coachId: coach ? coach.id : null,
      date: row._date,
    });
    if (!entry.courseName || !entry.scheduleDate || !entry.startTime || !entry.endTime) {
      stats.skipped += 1;
      continue;
    }
    const res = await upsertSchedule(entry);
    stats[res.action] += 1;
  }

  await invalidateTimelineCache();
  return stats;
}
