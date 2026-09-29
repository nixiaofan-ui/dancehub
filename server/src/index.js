import "dotenv/config";
import { createApp } from "./app.js";
import { redis } from "./lib/redis.js";
import { startReminderJob } from "./jobs/reminder.job.js";
import { startCrawlScheduler, probeOutbound, maybeDedupeStudios } from "./crawler/index.js";
import { maybeDedupeSchedules } from "./lib/dedupe-schedules.js";
import { getRuntimeMode } from "./lib/runtime-mode.js";
import { ensureSchema } from "./lib/ensure-schema.js";
import { calibrateGstepsCity } from "./lib/calibrate-gsteps-city.js";
import { ensureJiaheStores } from "./lib/ensure-jiahe-stores.js";

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
  ensureSchema()
    .catch((err) => console.warn(`[dancehub] ensure-schema 失败: ${err.message}`))
    // G-STEPS 分店城市校准（幂等）：早期把上海分店挂到了北京名下。
    // 挂在启动流程里是因为云端库没法从本机改，为了跑一次校准去开云库公网不划算。
    .then(() =>
      calibrateGstepsCity({ log: (m) => console.log(m) }).catch((err) =>
        console.warn(`[dancehub] G-STEPS 城市校准失败: ${err.message}`)
      )
    )
    // 嘉禾门店补齐（幂等）：课表接口只给「当天有课」的门店，新开的马家堡店
    // 这类没排课的分店会整个从库里消失。启动时按门店档案补一次。
    .then(() =>
      ensureJiaheStores({ log: (m) => console.log(m) }).catch((err) =>
        console.warn(`[dancehub] 嘉禾门店补齐失败: ${err.message}`)
      )
    )
    // 重复门店自愈（幂等）：同一个抓取目标被两份配置/两个实例各建了一条门店，
    // 用户会在对比页看到「两家同名门店」，课表是两个库的并集（多出来的课约不到）。
    // 2026-09-29 南京 D-DAY 舞蹈 就是这么被老板发现的 —— 云端库没法从本机改，
    // 所以挂在启动流程里自愈，代价只有几条 SQL。
    .then(() =>
      maybeDedupeStudios("startup").catch((err) =>
        console.warn(`[dancehub] 重复门店自愈失败: ${err.message}`)
      )
    )
    // 重复课表自愈（幂等）：同一节课被两份抓取/并发实例各插一条时，
    // 用户在周课表上看到同一节课列两遍（一条带预约人数一条不带）。
    // 2026-09-29 t-rex dance 就是这么被发现的；全库当时积压 16658 组。
    // 挂在启动流程里一并清掉，之后由抓取心跳每小时增量维护。
    // CRAWL_MODE=off（本地只想开接口时）也会跑这里，所以不必依赖调度器。
    .then(() =>
      maybeDedupeSchedules("startup").catch((err) =>
        console.warn(`[dancehub] 重复课表自愈失败: ${err.message}`)
      )
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