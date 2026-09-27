/**
 * 调度模式判定。
 *
 * 单独抽成一个模块，是因为它有两处消费方：容器启动（src/index.js，决定要不要
 * 启动进程内定时器）和自检接口（/api/crawler/probe，用来远程判断线上到底跑没跑抓取）。
 * 两处各写一遍条件表达式迟早会漂移——线上显示「在跑」而实际没跑，是最难查的一类问题。
 *
 * 模式：
 *   scheduler（默认）—— 进程内心跳，本地常驻进程 / 云端常驻实例
 *   trigger          —— 进程内不起定时器，由云托管定时触发器调 tick 接口
 *   off              —— 完全不调度（SKIP_CRAWLER=1，旧开关）
 */
export function getRuntimeMode() {
  const crawlMode =
    process.env.CRAWL_MODE === "trigger"
      ? "trigger"
      : process.env.SKIP_CRAWLER === "1"
        ? "off"
        : "scheduler";

  return {
    crawlMode,
    /** off / trigger 都不启动进程内提醒 cron */
    skipReminder: crawlMode === "trigger" || process.env.SKIP_REMINDER === "1",
    nodeEnv: process.env.NODE_ENV || "development",
    /** 一轮最多抓多久，超预算剩下的留给下一轮 */
    budgetMinutes: Number(process.env.CRAWL_BUDGET_MS || 15 * 60 * 1000) / 60000,
    concurrency: Number(process.env.CRAWL_CONCURRENCY || 3),
    /** 说明这条模式意味着什么，直接回给排查的人看，省得再去翻文档 */
    note:
      crawlMode === "scheduler"
        ? "进程内心跳已启动，容器存活期间会自动抓取"
        : crawlMode === "trigger"
          ? "等待定时触发器调用 /api/crawler/tick"
          : "SKIP_CRAWLER=1：当前不会自动抓取，数据需从本机同步",
  };
}
