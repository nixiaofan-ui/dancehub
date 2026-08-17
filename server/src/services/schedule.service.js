import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

const TIMELINE_TTL = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateKey(d) {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(dateKey, days) {
  const date = parseDateKey(dateKey);
  return toDateKey(new Date(date.getTime() + days * DAY_MS));
}

function timelineCacheKey(cityId, dateKey) {
  return `timeline:${cityId}:${dateKey}`;
}

export async function invalidateTimelineCache() {
  try {
    const keys = await redis.keys("timeline:*");
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    console.warn(`[dancehub] invalidate cache failed: ${err.message}`);
  }
}

const scheduleInclude = {
  studio: {
    include: { city: true },
  },
  coach: true,
};

function serializeTimeline(schedules) {
  return schedules.map((s) => ({
    id: s.id,
    courseName: s.courseName,
    difficulty: s.difficulty,
    scheduleDate: toDateKey(s.scheduleDate),
    startTime: s.startTime.toTimeString().slice(0, 5),
    endTime: s.endTime.toTimeString().slice(0, 5),
    bookingUrl: s.bookingUrl,
    remark: s.remark,
    coach: s.coach ? { id: s.coach.id, name: s.coach.name } : null,
    studio: {
      id: s.studio.id,
      name: s.studio.name,
      platform: s.studio.platform,
      logoUrl: s.studio.logoUrl,
      cityId: s.studio.cityId,
      city: s.studio.city?.name,
      region: s.studio.city?.region,
    },
  }));
}

export async function getCityDaySchedules(cityId, dateKey) {
  const cacheKey = timelineCacheKey(cityId, dateKey);

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const schedules = await prisma.schedule.findMany({
    where: {
      scheduleDate: parseDateKey(dateKey),
      studio: { cityId: Number(cityId), status: true },
    },
    include: scheduleInclude,
    orderBy: { startTime: "asc" },
  });

  const data = serializeTimeline(schedules);
  await redis
    .set(cacheKey, JSON.stringify(data), "EX", TIMELINE_TTL)
    .catch(() => {});
  return data;
}

export async function createSchedule(data) {
  const schedule = await prisma.schedule.create({ data });
  await invalidateTimelineCache();
  return schedule;
}

export async function updateSchedule(id, data) {
  const schedule = await prisma.schedule.update({ where: { id: Number(id) }, data });
  await invalidateTimelineCache();
  return schedule;
}

export async function deleteSchedule(id) {
  await prisma.schedule.delete({ where: { id: Number(id) } });
  await invalidateTimelineCache();
}

export async function listSchedules({ studioId, coachId, from, to }) {
  const where = {};
  if (studioId) where.studioId = Number(studioId);
  if (coachId) where.coachId = Number(coachId);
  if (from) where.scheduleDate = { gte: parseDateKey(from) };
  if (to) where.scheduleDate = { ...where.scheduleDate, lte: parseDateKey(to) };

  const rows = await prisma.schedule.findMany({
    where,
    include: scheduleInclude,
    orderBy: [{ scheduleDate: "asc" }, { startTime: "asc" }],
  });

  return rows.map((s) => ({
    ...serializeTimeline([s])[0],
    rawDate: s.scheduleDate,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

export async function copyPreviousWeek({ start, end }) {
  const startKey = toDateKey(start);
  const endKey = toDateKey(end);

  let created = 0;
  let dateKey = startKey;
  while (dateKey <= endKey) {
    const prevKey = addDays(dateKey, -7);
    const prevSchedules = await prisma.schedule.findMany({
      where: { scheduleDate: parseDateKey(prevKey) },
    });

    for (const prev of prevSchedules) {
      const exists = await prisma.schedule.findFirst({
        where: {
          scheduleDate: parseDateKey(dateKey),
          studioId: prev.studioId,
          courseName: prev.courseName,
        },
      });
      if (exists) continue;

      await prisma.schedule.create({
        data: {
          studioId: prev.studioId,
          coachId: prev.coachId,
          courseName: prev.courseName,
          difficulty: prev.difficulty,
          scheduleDate: parseDateKey(dateKey),
          startTime: prev.startTime,
          endTime: prev.endTime,
          bookingUrl: prev.bookingUrl,
          remark: prev.remark,
        },
      });
      created += 1;
    }

    dateKey = addDays(dateKey, 1);
  }

  await invalidateTimelineCache();
  return { created, range: `${startKey} ~ ${endKey}` };
}