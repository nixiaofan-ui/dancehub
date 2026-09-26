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
import {
  crawlerConfigs,
  getCrawlerConfig,
  listCrawlerConfigs,
} from "./configs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "../../.crawl-state.json"); // 仅一次性迁移用
const HEARTBEAT_MS = 5 * 60 * 1000; // 心跳：5 分钟
const DEFAULT_REFRESH_HOURS = 6; // 未配置时的默认刷新间隔

/**
 * 这些模式一次请求就带回全量课表，忽略传入的 date。
 * 对它们按日期循环调用只会重复打同一个页面（1MILLION 配了 days:30 = 30 次），
 * 而 importer 又是按「studio+date+课名+开始时间」upsert，多出来的全是无用功。
 * 因此只对第一个日期抓一次。
 */
const DATELESS_MODES = new Set(["oneMillion", "avex", "justjerk", "rawgraphy"]);

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
    for (const date of loopDates) {
      const raw = await crawl(config, date);
      rows.push(...raw.map((r) => ({ ...r, _date: date })));
    }
    const report = dryRun
      ? { dryRun: true, total: rows.length, rows: rows.map((r) => ({ ...r, _date: r._date.toISOString().slice(0, 10) })) }
      : await importSchedules(config, rows);

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

/** 心跳：到期的配置逐个补跑 */
async function tick(reason = "heartbeat") {
  const now = Date.now();
  for (const c of crawlerConfigs) {
    if (!c.enabled) continue;
    if (running.has(c.id)) continue;
    if (!isDue(c, now)) continue;

    const last = lastSuccessMs(c.id);
    const note = last === null
      ? "从未成功过"
      : `距上次成功 ${((now - last) / 3600_000).toFixed(1)}h > ${refreshHours(c)}h`;
    console.log(`[crawler] ${c.id} 触发抓取（${reason}；${note}）`);

    running.add(c.id);
    try {
      const report = await runCrawl(c.id);
      console.log(`[crawler] ${c.id} 抓取完成：${report.total} 条，门店 ${report.studios?.join(" / ") || "-"}`);
    } catch (e) {
      console.error(`[crawler] ${c.id} 抓取失败:`, e.message);
    } finally {
      running.delete(c.id);
    }
  }
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
