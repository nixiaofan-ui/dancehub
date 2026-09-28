import "dotenv/config";
import { createApp } from "./app.js";
import { redis } from "./lib/redis.js";
import { startReminderJob } from "./jobs/reminder.job.js";
import { startCrawlScheduler, probeOutbound } from "./crawler/index.js";
import { getRuntimeMode } from "./lib/runtime-mode.js";
import { ensureSchema } from "./lib/ensure-schema.js";

// ── 容器/云托管适配 ──
// 云托管要求监听 80 / 8080；本地开发仍可走 3000。
const port = Number(process.env.PORT || 80);
// 调度模式判定见 lib/runtime-mode.js —— 自检接口共用同一份逻辑，
// 保证「线上报告的模式」和「实际启动的定时器」不会漂移。
const { crawlMode, skipReminder, nodeEnv } = getRuntimeMode();

if (!process.env.DATABASE_URL) {
  console.error("[dancehub] DATABASE_URL 未设置，容器无法启动");
  process.exit(1);
}

const app = createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`[dancehub] API listening on http://0.0.0.0:${port}`);
  console.log(
    `[dancehub] NODE_ENV=${nodeEnv} CRAWL_MODE=${crawlMode}` +
      (skipReminder ? " SKIP_REMINDER" : "")
  );

  // 补齐新增表（幂等 DDL）。容器不像本地那样跑 prisma migrate deploy，
  // 没有它线上就会一直缺表。失败只 warn，不让整个服务起不来。
  ensureSchema().catch((err) =>
    console.warn(`[dancehub] ensure-schema 失败: ${err.message}`)
  );

  // 出口连通性自检（异步，只打日志）：云端抓取能不能跑，全看容器能否出公网。
  // 三种模式都跑 —— 排查「为什么云上没抓到数据」时，这条日志是唯一决定性证据。
  probeOutbound().catch((e) =>
    console.warn(`[dancehub] 连通性自检异常: ${e.message}`)
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