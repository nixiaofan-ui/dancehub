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

/**
 * 可见范围条件：公共课（ownerId 为空）+ 当前用户自己录入的课。
 * 拿不到 userId（未登录 / 内部调用）时只看公共课。
 *
 * @param {number|null} userId
 */
export function visibleScope(userId) {
  const uid = Number(userId);
  if (!uid) return { ownerId: null };
  return { OR: [{ ownerId: null }, { ownerId: uid }] };
}

/** 公共课与私课合并后要按时间重排一次，否则私课会全堆在末尾。 */
function byStartTime(a, b) {
  return String(a.startTime).localeCompare(String(b.startTime));
}

function serializeTimeline(schedules, userId) {
  const uid = Number(userId) || null;
  return schedules.map((s) => ({
    id: s.id,
    courseName: s.courseName,
    difficulty: s.difficulty,
    scheduleDate: toDateKey(s.scheduleDate),
    startTime: s.startTime.toTimeString().slice(0, 5),
    endTime: s.endTime.toTimeString().slice(0, 5),
    bookingUrl: s.bookingUrl,
    coursePicUrl: s.coursePicUrl,
    remark: s.remark,
    // 自己录的课前端要标「我录的」并允许删除，光给 ownerId 前端没法比对
    mine: uid ? Number(s.ownerId) === uid : false,
    coach: s.coach ? { id: s.coach.id, name: s.coach.name } : null,
    studio: {
      id: s.studio.id,
      name: s.studio.name,
      platform: s.studio.platform,
      logoUrl: s.studio.logoUrl,
      // 官方约课小程序 appId（有则预约面板直接跳转）
      bookingMiniAppId: s.studio.bookingMiniAppId,
      // 官网/官方预约页：海外店没有小程序，改走 web-view 打开
      officialUrl: s.studio.officialUrl,
      cityId: s.studio.cityId,
      city: s.studio.city?.name,
      region: s.studio.city?.region,
    },
  }));
}

/**
 * 某城市某天的课表。
 *
 * 缓存策略有个坑：key 只有「城市+日期」，如果把私课也塞进缓存，
 * A 用户录的课会被 B 用户看到。所以缓存里只放**公共课**，
 * 用户自己的课每次单独查再合并 —— 多一次小查询，换缓存仍能共用。
 *
 * @param {number} cityId
 * @param {string} dateKey YYYY-MM-DD
 * @param {number|null} userId
 */
export async function getCityDaySchedules(cityId, dateKey, userId) {
  const cacheKey = timelineCacheKey(cityId, dateKey);

  const cached = await redis.get(cacheKey).catch(() => null);
  let data = cached ? JSON.parse(cached) : null;

  if (!data) {
    const schedules = await prisma.schedule.findMany({
      where: {
        scheduleDate: parseDateKey(dateKey),
        studio: { cityId: Number(cityId), status: true },
        ownerId: null,
      },
      include: scheduleInclude,
      orderBy: { startTime: "asc" },
    });

    data = serializeTimeline(schedules, null);
    await redis
      .set(cacheKey, JSON.stringify(data), "EX", TIMELINE_TTL)
      .catch(() => {});
  }

  const uid = Number(userId);
  if (!uid) return data;

  const mine = await prisma.schedule.findMany({
    where: {
      scheduleDate: parseDateKey(dateKey),
      studio: { cityId: Number(cityId), status: true },
      ownerId: uid,
    },
    include: scheduleInclude,
    orderBy: { startTime: "asc" },
  });
  if (!mine.length) return data;

  return [...data, ...serializeTimeline(mine, uid)].sort(byStartTime);
}

/**
 * 自定义门店组合某一天的课表。
 * 与 getCityDaySchedules 的区别：不看城市，只看传入的门店 id 集合，
 * 供「品牌多店」「老师跨店」这类自选门店组复用。
 *
 * 不走 Redis 缓存：门店组合是任意的，key 会爆炸且命中率极低，
 * 单日几十到几百条直接查库更快也更省心。
 *
 * @param {number[]} studioIds
 * @param {string} dateKey YYYY-MM-DD（或区间起始日）
 * @param {string} [endKey] 给了就查 [dateKey, endKey] 区间，否则只查 dateKey 当天
 */
export async function getStudiosDaySchedules(studioIds, dateKey, endKey, userId) {
  const ids = [...new Set(studioIds.map(Number))].filter(Boolean);
  if (!ids.length) return [];

  const where = {
    studioId: { in: ids },
    studio: { status: true },
    ...visibleScope(userId),
  };
  where.scheduleDate = endKey
    ? { gte: parseDateKey(dateKey), lte: parseDateKey(endKey) }
    : parseDateKey(dateKey);

  const schedules = await prisma.schedule.findMany({
    where,
    include: scheduleInclude,
    // 区间查询必须先把日期排好，否则多天混在一起前端没法按天分组
    orderBy: endKey
      ? [{ scheduleDate: "asc" }, { startTime: "asc" }]
      : { startTime: "asc" },
  });

  return serializeTimeline(schedules, userId);
}

/**
 * 某个老师未来在某个城市的全部课程。
 *
 * 老师是跟着人走的，但数据里 Coach 挂在门店下 —— 同一个人在 A 店和 B 店
 * 是两条不同 id 的记录。所以这里按「同城 + 同名」聚合，
 * 这是目前唯一能跨店认出同一个老师的办法。
 *
 * 误差两边都有：不同人重名会被当成同一个（舞蹈圈重名率不高，可接受），
 * 同一人用不同艺名会漏掉。等有精力做教练 Identity 表再收敛。
 *
 * @param {string} coachName
 * @param {number} cityId
 * @param {string} fromKey YYYY-MM-DD
 * @param {string} [toKey]
 */
export async function getCoachSchedules(coachName, cityId, fromKey, toKey, userId) {
  const where = {
    coach: { name: coachName, studio: { cityId: Number(cityId) } },
    studio: { status: true },
    ...visibleScope(userId),
    scheduleDate: toKey
      ? { gte: parseDateKey(fromKey), lte: parseDateKey(toKey) }
      : { gte: parseDateKey(fromKey) },
  };

  const schedules = await prisma.schedule.findMany({
    where,
    include: scheduleInclude,
    orderBy: [{ scheduleDate: "asc" }, { startTime: "asc" }],
  });

  return serializeTimeline(schedules, userId);
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

export async function listSchedules({ studioId, coachId, from, to, userId }) {
  const where = { ...visibleScope(userId) };
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
    ...serializeTimeline([s], userId)[0],
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