/**
 * 停抓门店退休（幂等，可重复执行）。
 *
 * 场景：一家店上游已经死了（关店 / 换了 SaaS），或我们主动不再接入。
 * 配置侧在**顶层**标一行 `retired: true`，表达「这家店退休了，别再给它挂数据」。
 *
 * ⚠ 为什么必须有这个模块：`pruneVanished` 只清「本轮抓到过课的 门店+日期」——
 *   上游整个空返回的门店，一天都进不了清理范围，于是**旧课永久滞留**。
 *   实测（2026-10-09）：澜·锦序（id 1093）上游连测 14 天全空，库里还挂着
 *   10-01~10-07 的课；而且它被标成北京（地址是银川），用户在北京列表里
 *   点进去看到的是一家已经没课的银川店 —— 比不显示更糟。
 *   停抓门店（enabled:false）也有同样的问题，只是成因不同。
 *
 * 动作两件：
 *   ① 门店置为不可见 —— `status=false`。列表/课表/教练/搜索接口默认都带
 *      `status: true`（studio.routes.js 里 `includeInactive !== "1"` 才放开），
 *      所以置 false 就是彻底下线。
 *   ② 删掉它**今天及以后**的课。有预约 / 有提醒的课留着 —— 删了会连带删掉
 *      用户自己的记录（Reminder 是外键）。过去的课也留着：前端按日期查，
 *      历史课不会露出来，留着还有审计价值。
 *
 * ⚠ 与 `enabled: false` 的区别：`enabled: false` 只是「暂时别抓」（调参、排障时
 *   常用），店还得留着可见；`retired: true` 才是「这家店没了」。所以判据只认
 *   retired，不认 enabled，免得调个参数就把店下线了。
 *
 * ⚠ 只认同名精确匹配、且会处理**所有**同名记录：改名后遗留的空壳店也一并下线，
 *   否则它会带着旧课继续被搜到。
 */
import { prisma } from "./prisma.js";
import { crawlerConfigs } from "../crawler/configs.js";
import { invalidateStudioIndex } from "./studio-index.js";
import { invalidateTimelineCache } from "../services/schedule.service.js";

const RETIRE_MS = 6 * 3600_000;
let lastRunAt = 0;

/** 今天（UTC 午夜），与 Schedule.scheduleDate 的 @db.Date 同口径 */
function utcToday() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/**
 * @param {{ log?: (msg: string) => void, configs?: any[] }} [opts]
 * @returns {Promise<{ targets: number, retired: number, pruned: number, missing: number }>}
 */
export async function retireStudios(opts = {}) {
  const log = opts.log || (() => {});
  const configs = opts.configs || crawlerConfigs;
  const targets = configs.filter((c) => c && c.retired === true && c.studio && c.studio.name);

  const today = utcToday();
  let retired = 0;
  let pruned = 0;
  let missing = 0;

  for (const c of targets) {
    const name = String(c.studio.name).trim();
    const studios = await prisma.studio.findMany({
      where: { name },
      select: { id: true, name: true, status: true },
    });
    // 配置标了退休但库里还没建过这家店 → 什么都不用做（幂等稳态）
    if (!studios.length) {
      missing += 1;
      continue;
    }

    for (const s of studios) {
      const del = await prisma.schedule.deleteMany({
        where: {
          studioId: s.id,
          ownerId: null,
          scheduleDate: { gte: today },
          bookings: { none: {} },
          reminders: { none: {} },
        },
      });
      pruned += del.count;

      if (s.status !== false) {
        await prisma.studio.update({ where: { id: s.id }, data: { status: false } });
        retired += 1;
        log(`[retire] #${s.id}「${s.name}」下线（清未来课 ${del.count} 节）`);
      } else if (del.count) {
        log(`[retire] #${s.id}「${s.name}」清残留课 ${del.count} 节`);
      }
    }
  }

  if (retired || pruned) {
    // 门店可见性变了 → 搜索索引必须失效；课删了 → 时间轴缓存必须失效
    if (retired) invalidateStudioIndex();
    await invalidateTimelineCache().catch(() => {});
    log(`[retire] 停抓门店退休：下线 ${retired} 家，清课 ${pruned} 节`);
  }
  return { targets: targets.length, retired, pruned, missing };
}

/**
 * tick 里的节流包装。启动流程直接调 retireStudios 走全量，不走这里。
 * @param {string} [reason]
 * @param {{ force?: boolean }} [opts]
 */
export async function maybeRetireStudios(reason = "tick", opts = {}) {
  const now = Date.now();
  if (!opts.force && now - lastRunAt < RETIRE_MS) return null;
  lastRunAt = now;
  try {
    const r = await retireStudios({ log: (m) => console.log(m) });
    if (r.retired || r.pruned) {
      console.log(`[crawler] ${reason}：停抓门店退休 ${r.retired} 家 / 清课 ${r.pruned} 节`);
    }
    return r;
  } catch (e) {
    console.error(`[crawler] 停抓门店退休失败: ${e.message}`);
    return null;
  }
}
