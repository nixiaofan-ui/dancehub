/**
 * 实时预约人数：打开课程详情时回源舞室官方系统，拿当前真实已约数。
 *
 * 为什么需要这个：每日定时抓取的结果到这里已经是「几小时前」的快照，
 * 热门课开抢后数字会失真。用户在详情页停留时看到的应该是当下的热度。
 *
 * 做法不是「给每个平台写一个单课接口」（维护成本太高），而是复用现有的
 * crawl(config, date)：拉这家店当天的全量课表，在本地按 门店+课名+时间
 * 匹配出目标那节，只更新它的 bookedNum。一次网络请求顺带把同店其他课
 * 也刷新进缓存。
 *
 * ⚠ 代价是每次回源要拉整店课表（多的几百节），所以加了 60 秒进程内缓存；
 * 且不追求「必须成功」——拿不到就 fall back 到库里的旧值，接口不报错。
 */

import { prisma } from "./prisma.js";
import { crawlerConfigs } from "../crawler/configs.js";
import { crawl } from "../crawler/engine.js";
import { parseTimeRange } from "../crawler/mapper.js";

/** 同一家店 N 秒内不重复回源（ms） */
const TTL_MS = 60 * 1000;
/** 回源超时兜底（ms），超出直接放弃，用旧值 */
const UPSTREAM_TIMEOUT_MS = 15000;

/** studioId -> { at: number, promise } */
const inflight = new Map();
/** studioId -> { at: number, rows: 原始条目[] } */
const cache = new Map();

/** 批量刷新节流（ms）：同一家店同一天 2 分钟内只回源一次 */
const DAY_TTL_MS = 2 * 60 * 1000;
/** "studioId|YYYY-MM-DD" -> 上次回源时间 */
const dayRefreshed = new Map();

/** toString("HH:mm")，和 engine 里time 字段格式对齐 */
const hhmm = (startTime) => {
  if (!startTime) return "";
  const h = String(startTime.getUTCHours()).padStart(2, "0");
  const m = String(startTime.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
};

/**
 * 为一家出现的 studio 找到抓取配置。
 * 库里的门店名形态不统一：「MAX POWER STUDIO（汶水路店）」「嘉禾舞社·马家堡」「王牌嘻帝·五四北」，
 * 而配置的 studio.name 一般是品牌名，所以做前缀匹配而不是全等。
 */
export function findConfig(studioName, cityName) {
  const name = String(studioName || "").trim();
  if (!name) return null;
  const candidates = crawlerConfigs.filter((c) => {
    if (!c.enabled) return false;
    const base = String(c.studio?.name || "").trim();
    if (!base) return false;
    return name === base || name.startsWith(`${base}·`) || name.startsWith(`${base}（`);
  });
  if (!candidates.length) return null;
  // 同城优先：连锁品牌同名时（如跨城同城名）避免选错
  if (cityName) {
    const same = candidates.find((c) => String(c.studio?.city || "").trim() === cityName);
    if (same) return same;
  }
  return candidates[0];
}

/** 拉这家店当天的原始课表条目 */
async function loadStudioRows(studio) {
  const now = Date.now();
  const hit = cache.get(studio.id);
  if (hit && now - hit.at < TTL_MS) return hit.rows;

  // 并发去重：同一家店同时被多个详情请求打到时只回源一次
  if (inflight.has(studio.id)) return inflight.get(studio.id);

  const task = (async () => {
    const cityName = studio.city?.name || "";
    const config = findConfig(studio.name, cityName);
    if (!config) return null;

    const rows = await crawl(config, studioDate(studio));
    cache.set(studio.id, { at: Date.now(), rows });
    return rows;
  })().finally(() => inflight.delete(studio.id));

  inflight.set(studio.id, task);
  return task;
}

/** 用 schedule 自己的日期作为回源日期（历史课也能刷） */
function studioDate(schedule) {
  const d = schedule.scheduleDate;
  if (!d) return new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * 查询一门课的实时预约人数。
 * @returns {{ bookedNum: number|null, capacity: number|null, live: boolean, checkedAt: string }}
 *   live=false 表示没能回源，返回的是库里的旧值
 */
export async function getLiveBooking(schedule) {
  const fallback = {
    bookedNum: schedule.bookedNum ?? null,
    capacity: schedule.capacity ?? null,
    live: false,
    checkedAt: schedule.updatedAt ? schedule.updatedAt.toISOString() : null,
  };

  try {
    const rows = await withTimeout(loadStudioRows(schedule.studio), UPSTREAM_TIMEOUT_MS);
    if (!Array.isArray(rows) || !rows.length) return fallback;

    const studioName = String(schedule.studio?.name || "");
    const hit = matchRow(rows, schedule, studioName);
    if (!hit) return fallback;

    let bookedNum = hit._bookedNum != null ? Number(hit._bookedNum) : null;
    if (Number.isNaN(bookedNum)) bookedNum = null;

    // 顺手把新鲜值落库，下次列表页/他人请求直接读到新的
    if (bookedNum != null && bookedNum !== schedule.bookedNum) {
      prisma.schedule
        .update({ where: { id: schedule.id }, data: { bookedNum } })
        .catch(() => {}); // 更新失败无所谓，不影响本次响应
    }

    const total = parseTotal(hit.capacity) ?? schedule.capacity ?? null;
    return {
      bookedNum: bookedNum ?? fallback.bookedNum,
      capacity: total,
      live: bookedNum != null,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    // 回源失败（超时 / 平台抽风 / 该店未接入）：静默降级到旧值
    return fallback;
  }
}

/**
 * 在回源结果里找出「库里这节课」对应的那一条。
 * 先按课名 + 开始时间精确匹配；同名不同点时课名可能带分店前缀，放宽到只比时间 + 包含关系。
 */
function matchRow(rows, schedule, studioName) {
  const start = hhmm(schedule.startTime);
  const wantName = String(schedule.courseName || "").trim();
  return (
    rows.find(
      (r) =>
        String(r.courseName || "").trim() === wantName &&
        hhmm(parseTimeRange(r.time).startTime) === start &&
        rowMatchesStudio(r, studioName),
    ) ||
    rows.find(
      (r) =>
        hhmm(parseTimeRange(r.time).startTime) === start &&
        rowMatchesStudio(r, studioName) &&
        (String(r.courseName || "").includes(wantName) ||
          wantName.includes(String(r.courseName || "").trim())),
    ) ||
    null
  );
}

/**
 * 批量刷新「一家店某一天」所有课的预约人数。
 *
 * 详情页的 getLiveBooking 一次只解决一节，而周课表/首页一屏就是十几节 ——
 * 逐节调那个接口会打出几十个请求（每个都触发一次回源），既慢又容易被平台限流。
 * 这里复用同一份回源结果（loadStudioRows 本身有缓存），一次网络请求刷新整店当天。
 *
 * 节流 2 分钟：课表页反复切日期/下拉不该反复打上游。
 *
 * @returns {Promise<{ live: boolean, items: {id:number, bookedNum:number}[], throttled?: boolean }>}
 *   live=false 表示没能回源（未接入该平台/超时/被节流），前端保持库里旧值即可
 */
export async function refreshStudioDay(studio, date) {
  const empty = { live: false, items: [] };
  if (!studio || !date) return empty;

  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const key = `${studio.id}|${day.toISOString().slice(0, 10)}`;
  const now = Date.now();
  const last = dayRefreshed.get(key);
  if (last && now - last < DAY_TTL_MS) return { ...empty, throttled: true };

  try {
    const rows = await withTimeout(loadStudioRows(studio), UPSTREAM_TIMEOUT_MS);
    if (!Array.isArray(rows) || !rows.length) return empty;

    const schedules = await prisma.schedule.findMany({
      where: { studioId: studio.id, scheduleDate: day },
      select: { id: true, courseName: true, startTime: true, bookedNum: true },
    });
    if (!schedules.length) return empty;

    const studioName = String(studio.name || "");
    const items = [];
    const writes = [];
    for (const s of schedules) {
      const hit = matchRow(rows, s, studioName);
      if (!hit) continue;
      const num = hit._bookedNum != null ? Number(hit._bookedNum) : null;
      if (num == null || Number.isNaN(num)) continue;
      items.push({ id: s.id, bookedNum: num });
      if (num !== s.bookedNum) {
        writes.push(
          prisma.schedule.update({ where: { id: s.id }, data: { bookedNum: num } }),
        );
      }
    }
    // 落库：顺手把新鲜值写回，下一次即使回源失败，列表读到的也是几分钟前的真值
    if (writes.length) await Promise.all(writes).catch(() => {});

    dayRefreshed.set(key, now);
    return { live: true, items, checkedAt: new Date().toISOString() };
  } catch {
    return empty;
  }
}

function rowMatchesStudio(row, studioName) {
  const rn = String(row._studioName || "").trim();
  if (!rn) return false;
  const sn = String(studioName || "").trim();
  return rn === sn || sn.startsWith(rn) || rn.startsWith(sn) || rn.startsWith(sn.split(/[·（]/)[0]);
}

/** "8/20" → 20；"20" → 20 */
function parseTotal(text) {
  if (!text) return null;
  const t = String(text).trim();
  const ratio = t.match(/(\d+)\s*\/\s*(\d+)/);
  if (ratio) return Number(ratio[2]);
  const plain = t.match(/^(\d+)$/);
  return plain ? Number(plain[1]) : null;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("upstream timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
