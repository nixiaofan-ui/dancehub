import { prisma } from "../lib/prisma.js";
import { pickStyles } from "./dance-style.service.js";

/** 当天 UTC 零点，用于匹配 @db.Date 的 scheduleDate */
function todayUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * 批量算「门店 → 代表舞种」。
 *
 * 发现页卡片、关注列表都要显示「这家店教什么」，逻辑必须是一份 ——
 * 之前这段写在 studio.routes.js 里当局部函数，关注列表想用就只能再抄一份。
 *
 * 只统计今天（含）之后的课：已经过去的排课不代表这家店接下来教什么，
 * 而用户看这几个标签就是为了决定「要不要去这家」。
 *
 * @param {number[]} studioIds
 * @param {number} limit 每家店最多留几个舞种
 * @returns {Promise<Map<number, string[]>>}
 */
export async function buildStyleMap(studioIds, limit = 4) {
  const map = new Map();
  if (!studioIds || !studioIds.length) return map;

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
    map.set(id, pickStyles(list, limit));
  }
  return map;
}
