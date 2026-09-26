import "dotenv/config";
import { createApp } from "./app.js";
import { redis } from "./lib/redis.js";
import { startReminderJob } from "./jobs/reminder.job.js";
import { startCrawlScheduler } from "./crawler/index.js";

// ── 容器/云托管适配 ──
// 云托管要求监听 80 / 8080；本地开发仍可走 3000。
const port = Number(process.env.PORT || 80);
// 抓取/提醒调度模式：
//   scheduler（默认，本地常驻进程）—— 心跳自愈 + 每分钟提醒 cron
//   trigger（云托管定时触发器）     —— 不启动任何进程内定时器，
//                                     抓取/提醒均由控制台配的触发器调
//                                     POST /api/crawler/tick、POST /api/reminders/tick 驱动
//   off（SKIP_CRAWLER=1，旧开关）   —— 完全不调度
const crawlMode =
  process.env.CRAWL_MODE === "trigger"
    ? "trigger"
    : process.env.SKIP_CRAWLER === "1"
      ? "off"
      : "scheduler";
const skipReminder = crawlMode === "trigger" || process.env.SKIP_REMINDER === "1";

if (!process.env.DATABASE_URL) {
  console.error("[dancehub] DATABASE_URL 未设置，容器无法启动");
  process.exit(1);
}

const app = createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`[dancehub] API listening on http://0.0.0.0:${port}`);
  console.log(
    `[dancehub] NODE_ENV=${process.env.NODE_ENV || "development"} CRAWL_MODE=${crawlMode}` +
      (skipReminder ? " SKIP_REMINDER" : "")
  );

  // 抓取 / 提醒 / redis 任何一个挂掉都不能阻塞启动（云托管要求快速 ready）
  if (crawlMode === "scheduler") {
    try {
      startCrawlScheduler();
    } catch (e) {
      console.warn(`[dancehub] 抓取调度器启动失败: ${e.message}`);
    }
  } else if (crawlMode === "trigger") {
    console.log("[dancehub] 触发器模式：抓取/提醒由云托管定时触发器调用 /api/crawler/tick、/api/reminders/tick 驱动");
  }
  if (!skipReminder) {
    try {
      startReminderJob();
    } catch (e) {
      console.warn(`[dancehub] 提醒任务启动失败: ${e.message}`);
    }
  }

  // redis 仅供提醒 + 缓存，连不上也只 warn，不阻塞启动
  redis.connect().catch((err) =>
    console.warn(`[dancehub] Redis unavailable (${err.message}); API still serving`)
  );
});