/**
 * 抓取工作流编排 + 定时调度
 * runCrawl: 解析日期 → 抓取 → 映射 → 批量导入 → 返回报告
 * startCrawlScheduler: 按每套配置的 cron 表达式注册定时任务
 */
import cron from "node-cron";
import { crawl } from "./engine.js";
import { importSchedules } from "./importer.js";
import {
  crawlerConfigs,
  getCrawlerConfig,
  listCrawlerConfigs,
} from "./configs.js";

const statusMap = new Map(); // configId -> { state, lastRunAt, report, error }

function resolveDates(config) {
  if (config.dateMode === "dates" && Array.isArray(config.dates) && config.dates.length) {
    return config.dates.map((d) => new Date(`${d}T00:00:00Z`));
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
  try {
    const dates = resolveDates(config);
    const rows = [];
    for (const date of dates) {
      const raw = await crawl(config);
      rows.push(...raw.map((r) => ({ ...r, _date: date })));
    }
    const report = dryRun
      ? { dryRun: true, total: rows.length, rows: rows.map((r) => ({ ...r, _date: r._date.toISOString().slice(0, 10) })) }
      : await importSchedules(config, rows);

    statusMap.set(configId, { state: "done", lastRunAt: startedAt, report, error: null });
    return { configId, ...report };
  } catch (e) {
    statusMap.set(configId, { state: "error", lastRunAt: startedAt, report: null, error: e.message });
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

export function getCrawlStatus() {
  return crawlerConfigs.map((c) => ({
    id: c.id,
    label: c.label,
    enabled: c.enabled,
    mode: c.mode,
    cron: c.cron,
    status: statusMap.get(c.id) || null,
  }));
}

export function startCrawlScheduler() {
  let scheduled = 0;
  for (const c of crawlerConfigs) {
    if (!c.enabled || !c.cron) continue;
    cron.schedule(c.cron, () => {
      runCrawl(c.id).catch((e) =>
        console.error(`[crawler] ${c.id} 定时任务失败:`, e.message),
      );
    });
    scheduled += 1;
  }
  if (scheduled) console.log(`[crawler] scheduled ${scheduled} job(s)`);
  return scheduled;
}

export { crawlerConfigs, getCrawlerConfig, listCrawlerConfigs };
