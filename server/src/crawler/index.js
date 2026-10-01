/**
 * 抓取工作流编排 + 定时调度
 * runCrawl: 解析日期 → 抓取 → 映射 → 批量导入 → 返回报告
 * startCrawlScheduler: 注册「自愈式」调度（本地常驻进程用）
 * tickOnce: 云托管「定时触发器」模式入口（见 routes.js /tick）
 *
 * 为什么要自愈式调度：
 * node-cron 依赖进程内的定时器，机器休眠/关机期间到点的任务会被静默丢弃、不会补跑。
 * 因此改为「心跳 + 到期判断」：
 *   - 每 HEARTBEAT_MS 检查一次，只要距上次「成功抓取」超过 config.refreshHours 小时就立即补跑；
 *   - 启动 10 秒后先检查一次，补齐休眠/关机期间错过的窗口。
 *
 * 状态持久化（2026-09-22 起）：
 *   原来写 server/.crawl-state.json，容器文件系统重启即丢（云端全量重抓太重），
 *   改为落 MySQL CrawlState 表；启动时异步 hydrate 进内存。
 *   本地一次性迁移：库表为空且存在旧 .crawl-state.json 时自动导入。
 */
import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";
import { crawl } from "./engine.js";
import { importSchedules } from "./importer.js";
import { dedupeStudios } from "../lib/dedupe-studios.js";
import { maybeDedupeSchedules } from "../lib/dedupe-schedules.js";
import { ensureAddress } from "../lib/fill-address.js";
import { ensureLatLng } from "../lib/fill-latlng.js";
import { ensureDistrict } from "../lib/fill-district.js";
import {
  crawlerConfigs,
  getCrawlerConfig,
  listCrawlerConfigs,
} from "./configs.js";
// 复用「门店名 → 抓取配置」的匹配逻辑，避免这里再抄一份前缀匹配规则
import { findConfig as findStudioCrawlConfig } from "../lib/live-booking.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "../../.crawl-state.json"); // 仅一次性迁移用
const HEARTBEAT_MS = 5 * 60 * 1000; // 心跳：5 分钟
const DEFAULT_REFRESH_HOURS = 6; // 未配置时的默认刷新间隔
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 3); // 一轮同时抓几个配置
const TICK_BUDGET_MS = Number(process.env.CRAWL_BUDGET_MS || 15 * 60 * 1000); // 一轮最长时间

/**
 * 这些模式一次请求就带回全量课表，忽略传入的 date。
 * 对它们按日期循环调用只会重复打同一个页面（1MILLION 配了 days:30 = 30 次），
 * 而 importer 又是按「studio+date+课名+开始时间」upsert，多出来的全是无用功。
 * 因此只对第一个日期抓一次。
 */
const DATELESS_MODES = new Set(["oneMillion", "avex", "justjerk", "rawgraphy", "csdsp"]);

/**
 * 「热刷新」：只抓今天+明天，间隔远短于常规轮次。
 *
 * 为什么需要：常规一轮 6 小时，而预约人数在开抢后几十分钟就会变。
 * 用户拿官方小程序一对，我们永远是几小时前的快照。全平台 1237 个配置
 * 全部提到 20 分钟一轮既不现实（上游会限流）也没必要（冷门店没人看），
 * 所以单独挑一批「有人在看」的店高频刷。
 *
 * 只抓今天+明天：未来的课还没开放预约，人数不会动；过期课更没人看。
 */
const HOT_REFRESH_MS = Number(process.env.CRAWL_HOT_MS || 20 * 60 * 1000);
/** 一轮热刷新最多几家店的配置 */
const HOT_LIMIT = Number(process.env.CRAWL_HOT_LIMIT || 40);
const HOT_BUDGET_MS = Number(process.env.CRAWL_HOT_BUDGET_MS || 5 * 60 * 1000);
/** configId -> 上次热刷时间戳（与常规 lastSuccessAt 分开记，不能互相顶掉） */
const hotRefreshed = new Map();

const statusMap = new Map(); // configId -> { state, lastRunAt, report, error }
const running = new Set(); // 正在抓取的 configId，防重入
let state = {}; // 内存态：configId -> { lastAttemptAt, lastSuccessAt, lastError }

/** 启动时把库里的状态灌进内存（已存在的内存键不覆盖——本进程刚写入的更新） */
hydrate().catch((e) => console.warn("[crawler] 状态 hydrate 失败:", e.message));

async function hydrate() {
  const rows = await prisma.crawlState.findMany();
  if (!rows.length) {
    // 一次性迁移：旧 .crawl-state.json → 库
    let legacy = null;
    try {
      legacy = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      legacy = null;
    }
    if (legacy && Object.keys(legacy).length) {
      state = legacy;
      for (const [id, entry] of Object.entries(legacy)) {
        persist(id).catch(() => {});
      }
      console.log(`[crawler] 已从 .crawl-state.json 迁移 ${Object.keys(legacy).length} 条状态入库`);
      return;
    }
  }
  for (const r of rows) {
    if (state[r.id]) continue; // 内存里已有本进程新写入的值
    state[r.id] = {
      lastAttemptAt: r.lastAttemptAt?.toISOString() || null,
      lastSuccessAt: r.lastSuccessAt?.toISOString() || null,
      lastError: r.lastError || null,
    };
  }
}

/** 单条状态写库（fire-and-forget，失败只 warn） */
function persist(configId) {
  const entry = state[configId];
  if (!entry) return Promise.resolve();
  return prisma.crawlState.upsert({
    where: { id: configId },
    update: {
      lastAttemptAt: entry.lastAttemptAt ? new Date(entry.lastAttemptAt) : null,
      lastSuccessAt: entry.lastSuccessAt ? new Date(entry.lastSuccessAt) : null,
      lastError: entry.lastError || null,
    },
    create: {
      id: configId,
      lastAttemptAt: entry.lastAttemptAt ? new Date(entry.lastAttemptAt) : null,
      lastSuccessAt: entry.lastSuccessAt ? new Date(entry.lastSuccessAt) : null,
      lastError: entry.lastError || null,
    },
  }).catch((e) => console.warn(`[crawler] 状态写库失败 ${configId}:`, e.message));
}

function refreshHours(config) {
  const n = Number(config.refreshHours);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REFRESH_HOURS;
}

/** 上次成功抓取时间（毫秒）；从未成功过返回 null */
function lastSuccessMs(configId) {
  const at = state[configId]?.lastSuccessAt;
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isDue(config, now = Date.now()) {
  const last = lastSuccessMs(config.id);
  if (last === null) return true;
  return now - last >= refreshHours(config) * 3600_000;
}

function nextDueAt(config) {
  const last = lastSuccessMs(config.id);
  if (last === null) return new Date();
  return new Date(last + refreshHours(config) * 3600_000);
}

function resolveDates(config) {
  if (config.dateMode === "dates" && Array.isArray(config.dates) && config.dates.length) {
    return config.dates.map((d) => new Date(`${d}T00:00:00Z`));
  }
  if (config.dateMode === "nextDays") {
    const days = Math.max(1, Number(config.days) || 7);
    const today = new Date();
    const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Array.from({ length: days }, (_, i) => new Date(base + i * 86400000));
  }
  // 当天：规范到 UTC 午夜，保证与库中 @db.Date 的按天匹配
  const d = new Date();
  return [new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))];
}

export async function runCrawl(configId, { dryRun = false } = {}) {
  const config = getCrawlerConfig(configId);
  if (!config) throw new Error(`未找到抓取配置: ${configId}`);
  if (!config.enabled) throw new Error(`配置已停用: ${configId}`);

  const startedAt = new Date();
  statusMap.set(configId, { state: "running", lastRunAt: startedAt, report: null, error: null });
  const entry = state[configId] || {};
  entry.lastAttemptAt = startedAt.toISOString();
  state[configId] = entry;
  persist(configId);

  try {
    const dates = resolveDates(config);
    const once = DATELESS_MODES.has(config.mode);
    const loopDates = once ? dates.slice(0, 1) : dates;
    const rows = [];
    // 抓取器可以额外挂一份「只要建店」的门店清单（嘉禾：当天没课的新店也要入库）
    const ensureStudios = [];
    for (const date of loopDates) {
      const raw = await crawl(config, date);
      if (Array.isArray(raw.ensureStudios)) ensureStudios.push(...raw.ensureStudios);
      rows.push(...raw.map((r) => ({ ...r, _date: date })));
    }
    const report = dryRun
      ? { dryRun: true, total: rows.length, rows: rows.map((r) => ({ ...r, _date: r._date.toISOString().slice(0, 10) })) }
      : await importSchedules(config, rows, ensureStudios);

    statusMap.set(configId, { state: "done", lastRunAt: startedAt, report, error: null });
    entry.lastSuccessAt = new Date().toISOString();
    entry.lastError = null;
    persist(configId);
    return { configId, ...report };
  } catch (e) {
    statusMap.set(configId, { state: "error", lastRunAt: startedAt, report: null, error: e.message });
    entry.lastError = e.message;
    persist(configId);
    throw e;
  }
}

export async function runAllCrawls({ dryRun = false } = {}) {
  const results = [];
  for (const c of crawlerConfigs) {
    if (!c.enabled) continue;
    try {
      results.push(await runCrawl(c.id, { dryRun }));
    } catch (e) {
      results.push({ configId: c.id, error: e.message });
    }
  }
  return results;
}

/** UTC 午夜，offsetDays 天后 */
function utcDay(offsetDays = 0) {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + offsetDays * 86400000,
  );
}

/**
 * 挑出值得高频刷新的店：被关注数多的优先（说明有人在看），其次今天/明天课多的。
 * 返回去重后的 configId 列表（同品牌多分店通常共用一份配置）。
 */
async function pickHotConfigIds(limit) {
  const days = [utcDay(0), utcDay(1)];
  const [byStudio, follows] = await Promise.all([
    prisma.schedule.groupBy({
      by: ["studioId"],
      where: { scheduleDate: { in: days } },
      _count: { _all: true },
    }),
    prisma.follow.groupBy({ by: ["studioId"], _count: { _all: true } }),
  ]);
  if (!byStudio.length) return [];

  const fans = new Map(follows.map((f) => [f.studioId, f._count._all]));
  const ranked = byStudio
    .map((r) => ({
      id: r.studioId,
      lessons: r._count._all,
      fans: fans.get(r.studioId) || 0,
    }))
    .sort((a, b) => b.fans - a.fans || b.lessons - a.lessons)
    .slice(0, limit);

  const studios = await prisma.studio.findMany({
    where: { id: { in: ranked.map((r) => r.id) } },
    include: { city: true },
  });
  const ids = [];
  const seen = new Set();
  for (const s of studios) {
    const cfg = findStudioCrawlConfig(s.name, s.city?.name || "");
    if (!cfg || !cfg.enabled || seen.has(cfg.id)) continue;
    seen.add(cfg.id);
    ids.push(cfg.id);
  }
  return ids;
}

/**
 * 热刷新一轮：串行跑，成功与否都记自己的时间戳。
 *
 * ⚠ 不能复用 runCrawl：它会写 lastSuccessAt / statusMap，
 * 而热刷新只抓了今天+明天，冒充「整轮成功」会把常规 7 天抓取往后推。
 */
export async function maybeHotRefresh() {
  if (String(process.env.CRAWL_HOT ?? "1") === "0") return;
  let ids = [];
  try {
    ids = await pickHotConfigIds(HOT_LIMIT);
  } catch (e) {
    console.warn("[crawler] 热刷新选店失败:", e.message);
    return;
  }
  const now = Date.now();
  const queue = ids.filter((id) => {
    if (running.has(id)) return false;
    const last = hotRefreshed.get(id) || 0;
    return now - last >= HOT_REFRESH_MS;
  });
  if (!queue.length) return;

  console.log(
    `[crawler] 热刷新：${queue.length} 个配置（间隔 ${Math.round(HOT_REFRESH_MS / 60000)} 分钟，只抓今天+明天）`,
  );
  const deadline = Date.now() + HOT_BUDGET_MS;
  for (const id of queue) {
    if (Date.now() > deadline) {
      console.warn("[crawler] 热刷新超过时间预算，剩余下一轮继续");
      break;
    }
    running.add(id);
    try {
      const config = getCrawlerConfig(id);
      const dates = DATELESS_MODES.has(config.mode) ? [utcDay(0)] : [utcDay(0), utcDay(1)];
      const rows = [];
      for (const date of dates) {
        const raw = await crawl(config, date);
        rows.push(...raw.map((r) => ({ ...r, _date: date })));
      }
      const report = await importSchedules(config, rows);
      hotRefreshed.set(id, Date.now());
      console.log(`[crawler] 热刷新 ${id}：${report.total} 条`);
    } catch (e) {
      console.error(`[crawler] 热刷新 ${id} 失败:`, e.message);
    } finally {
      running.delete(id);
    }
  }
}

/** 启用中配置的「目标店名」集合 —— 判断重复门店里哪一条还在被更新，靠它 */
export function enabledStudioNames() {
  const names = new Set();
  for (const c of crawlerConfigs) {
    if (c.enabled && c.studio && c.studio.name) names.add(c.studio.name);
  }
  return names;
}

/**
 * 重复门店自愈。
 *
 * 什么时候会产生重复：① 同一个目标被两份配置各建一条（D-DAY 舞蹈：一个 box 被
 * auto 和 topcities 各扫到一次，店名还差一个「市」字）；② 新配置上线的瞬间
 * 两个容器实例同时补跑，findFirst 都说「没有」→ 各插一条同名记录。
 * 两种都只在库里留垃圾，不会自己消失，所以每次 tick 前先清一遍。
 *
 * 频率：启动时必跑，之后每小时最多一次（合并要读关注/课程，没必要每 5 分钟做）。
 */
let lastDedupeAt = 0;
const DEDUPE_INTERVAL_MS = 3600_000;

export async function maybeDedupeStudios(reason = "tick") {
  const force = reason === "startup";
  if (!force && Date.now() - lastDedupeAt < DEDUPE_INTERVAL_MS) return null;
  lastDedupeAt = Date.now();
  try {
    const res = await dedupeStudios({
      log: (m) => console.log(m),
      targetNames: enabledStudioNames(),
    });
    if (res.groups) {
      console.log(
        `[crawler] 重复门店自愈（${reason}）：发现 ${res.groups} 组，` +
          `隐藏 ${res.hidden} 条、迁移关注 ${res.movedFollows} 条、清理旧课 ${res.deletedSchedules} 节`,
      );
    }
    return res;
  } catch (e) {
    console.warn(`[crawler] 重复门店自愈失败: ${e.message}`);
    return null;
  }
}

/**
 * 心跳：到期的配置补跑。
 *
 * 并发 + 时间预算：全平台 587 家串行要 8 分钟，云端一轮跑太久既拖慢
 * 下次到期判断，也增加被目标平台限流的窗口。这里开 3 个并发（约 3 分钟），
 * 并用 TICK_BUDGET_MS 兜底——超预算就把剩下的留给下一轮，它们仍然到期，
 * 不会漏抓（CrawlState 记的是「上次成功时间」，没抓成功就还是 due）。
 */

/**
 * 抓完一轮把新门店的三件元数据补齐：**地址 → 坐标 → 行政区**（顺序不能换，区名从地址抽）。
 *
 * 为什么不能只靠启动时那一次：云端容器启动时，新接入的门店还没被创建（抓取要等启动
 * 之后才跑），而那三个回填都被「一个进程只跑一次」锁住 → 那批新店在库里地址/坐标/区名
 * 永远是 null。表现极具迷惑性：本地跑两轮全对，云端却是空的（2026-10-01 舞岚三家店
 * 地址坐标都在、区名为 null 就是这么来的）。
 *
 * 三个回填内部只查「还是 null」的行，所以每轮重复调用几乎是空查询，成本可忽略。
 *
 * 串行化：启动流程（src/index.js）也会调这三个，并发跑没有正确性问题（都是幂等 update），
 * 但会重复写、日志翻倍 → 用一条 Promise 链把调用串起来。
 */
let metaChain = Promise.resolve();

export function fillStudioMeta(reason = "tick") {
  metaChain = metaChain.then(async () => {
    try {
      const a = await ensureAddress({ force: true });
      const l = await ensureLatLng({ force: true });
      const d = await ensureDistrict({ force: true });
      const filled =
        (a?.filled || 0) + (l?.filled || 0) + (d?.filled || 0) + (d?.addressed || 0);
      if (filled) {
        console.log(
          `[crawler] ${reason}：门店元数据回填 地址 ${a?.filled || 0} / 坐标 ${l?.filled || 0} / 行政区 ${d?.filled || 0}`,
        );
      }
    } catch (e) {
      console.error("[crawler] 门店元数据回填失败:", e.message);
    }
  });
  return metaChain;
}

async function tick(reason = "heartbeat") {
  // 先自愈「同一家店被插了两条」再去抓：抓取时若两家同名门店都在库里，
  // 课程会分叉到两条记录上，用户看到的课表就是两家的并集（多出来的课约不到）
  await maybeDedupeStudios(reason);

  // 再清「同一节课被插了两条」（内部每小时节流）。
  // 为什么必须清：Schedule 表没有唯一约束，重复的两条在 pruneVanished 眼里
  // 「指纹相同、互相证明对方存在」，一旦产生就永远不会自己消失 ——
  // 2026-09-29 用户报「t-rex 的课表每节课都显示两遍」就是这么来的，
  // 当时全库积压了 710 家门店 / 16658 组。
  await maybeDedupeSchedules(reason);

  const now = Date.now();
  const queue = crawlerConfigs.filter(
    (c) => c.enabled && !running.has(c.id) && isDue(c, now),
  );
  if (!queue.length) {
    // 没有到期配置不代表没事做：热刷新是另一套节奏（20 分钟），别被这里挡住
    await maybeHotRefresh();
    return;
  }

  const deadline = Date.now() + TICK_BUDGET_MS;
  let cursor = 0;
  let overBudget = false;

  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) {
        overBudget = true;
        return;
      }
      const c = queue[cursor++];
      if (!c) return;

      const last = lastSuccessMs(c.id);
      const note =
        last === null
          ? "从未成功过"
          : `距上次成功 ${((Date.now() - last) / 3600_000).toFixed(1)}h > ${refreshHours(c)}h`;
      console.log(`[crawler] ${c.id} 触发抓取（${reason}；${note}）`);

      running.add(c.id);
      try {
        const report = await runCrawl(c.id);
        console.log(
          `[crawler] ${c.id} 抓取完成：${report.total} 条，门店 ${report.studios?.join(" / ") || "-"}`,
        );
      } catch (e) {
        console.error(`[crawler] ${c.id} 抓取失败:`, e.message);
      } finally {
        running.delete(c.id);
      }
    }
  };

  const n = Math.max(1, Math.min(CONCURRENCY, queue.length));
  console.log(`[crawler] ${reason}：${queue.length} 个配置到期，并发 ${n}`);
  await Promise.all(Array.from({ length: n }, worker));
  if (overBudget) {
    console.warn(
      `[crawler] 本轮超过时间预算 ${TICK_BUDGET_MS / 60000} 分钟，剩余配置下一轮继续`,
    );
  }

  // 常规补跑结束后顺带热刷新一轮（有人正在看的店，人数要新鲜）
  await maybeHotRefresh();

  // 新门店是在抓取里才被创建的，启动时那次回填看不见它们 → 这里补一次
  await fillStudioMeta(reason);
}

/**
 * 出口连通性自检：容器到底能不能访问外网。
 *
 * 云端抓取能不能成立，全看这一条——当初把云端抓取关掉（SKIP_CRAWLER=1）
 * 很可能就是因为容器出不去公网，而失败又只在日志里，数据端看不出来。
 * 现在启动时自动跑一次并打日志，也能通过 GET /api/crawler/probe 随时查。
 */
export async function probeOutbound() {
  const checks = [
    {
      name: "generic",
      label: "通用出网（baidu.com）",
      run: () =>
        fetch("https://www.baidu.com", { signal: AbortSignal.timeout(8000) }),
    },
    {
      name: "aiwugong",
      label: "爱舞功课表接口（真实业务请求）",
      run: () =>
        fetch("https://wushi.api.aiwugong.cn/Applets/course/index-not-login.html", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            host: "wx4d02b14543b4b8b8",
            brand_id: "149",
            date: new Date().toISOString().slice(0, 10),
            page: "1",
          }),
          signal: AbortSignal.timeout(12000),
        }),
    },
  ];

  const results = [];
  for (const c of checks) {
    const t0 = Date.now();
    try {
      const r = await c.run();
      results.push({
        name: c.name,
        label: c.label,
        ok: r.ok,
        status: r.status,
        ms: Date.now() - t0,
      });
    } catch (e) {
      results.push({
        name: c.name,
        label: c.label,
        ok: false,
        status: null,
        ms: Date.now() - t0,
        error: e.message,
      });
    }
  }
  const ok = results.some((r) => r.ok);
  const summary = results.map((r) => `${r.name}=${r.ok ? "OK" : "FAIL(" + (r.error || r.status) + ")"}`).join(" ");
  console.log(`[crawler] 出口连通性自检：${ok ? "可用" : "不可用"} — ${summary}`);
  return { ok, results, checkedAt: new Date().toISOString() };
}

/** 定时触发器入口（云托管控制台配 cron 调 POST /api/crawler/tick）。
 *  防重入：一轮没跑完时后续触发直接跳过。 */
let ticking = false;
export async function tickOnce(reason = "trigger") {
  if (ticking) return { started: false, reason: "already-running" };
  ticking = true;
  try {
    await tick(reason);
  } finally {
    ticking = false;
  }
  return { started: true };
}

/** 到期配置数量（tick 端点响应用，不触发抓取） */
export function dueCount() {
  const now = Date.now();
  return crawlerConfigs.filter((c) => c.enabled && !running.has(c.id) && isDue(c, now)).length;
}

export function getCrawlStatus() {
  const now = Date.now();
  return crawlerConfigs.map((c) => ({
    id: c.id,
    label: c.label,
    enabled: c.enabled,
    mode: c.mode,
    refreshHours: refreshHours(c),
    cron: c.cron || null,
    due: isDue(c, now),
    lastSuccessAt: state[c.id]?.lastSuccessAt || null,
    lastAttemptAt: state[c.id]?.lastAttemptAt || null,
    lastError: state[c.id]?.lastError || null,
    nextDueAt: nextDueAt(c).toISOString(),
    status: statusMap.get(c.id) || null,
  }));
}

export function startCrawlScheduler() {
  const enabled = crawlerConfigs.filter((c) => c.enabled);
  if (!enabled.length) {
    console.log("[crawler] 没有启用的抓取配置");
    return 0;
  }

  // 启动后先检查一次：补齐休眠/关机期间错过的抓取
  setTimeout(() => tick("startup"), 10_000).unref();
  // 心跳
  setInterval(() => tick("heartbeat"), HEARTBEAT_MS).unref();

  // 可选的固定时刻触发
  let cronCount = 0;
  for (const c of enabled) {
    if (!c.cron) continue;
    cron.schedule(c.cron, () => tick(`cron ${c.cron}`));
    cronCount += 1;
  }

  const now = Date.now();
  console.log(
    `[crawler] 自愈调度已启动（心跳 ${HEARTBEAT_MS / 60000} 分钟${
      cronCount ? `，固定 cron ${cronCount} 个` : ""
    }）`,
  );
  for (const c of enabled) {
    const last = lastSuccessMs(c.id);
    console.log(
      `[crawler] ${c.id}: 刷新间隔 ${refreshHours(c)}h，上次成功 ${
        last === null ? "无" : new Date(last).toLocaleString("zh-CN")
      }，${isDue(c, now) ? "启动后立即补跑" : `下次到期 ${nextDueAt(c).toLocaleString("zh-CN")}`}`,
    );
  }
  return enabled.length;
}

export { crawlerConfigs, getCrawlerConfig, listCrawlerConfigs };
