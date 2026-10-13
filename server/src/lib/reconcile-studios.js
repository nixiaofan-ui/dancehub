/**
 * 抓取对账 —— 让「上游已经删掉的门店」在库里自动退休（僵尸门店）。
 *
 * ## 为什么需要这个模块
 *
 * 库里的门店一旦建出来就再也不会消失：`pruneVanished` 只清「本轮抓到过课的
 * 门店 + 日期」的课，而**上游整个删掉一家店**时，这家店一天都进不了清理范围，
 * 于是它带着整周旧课永久滞留在库里（幽灵课）。用户在列表里点进去看到的是一家
 * 早就没了的店，比不接入更糟。
 *
 * 归并（`dedupe-studios`）管不了这件事：它合并的是「同一家店被建了两条」，
 * 而僵尸店的特征恰恰是**名字和城市都跟活着的店不一样**（G-STEPS 上游列表里
 * 只有「上海新天地店」，库里却还留着「新天地湖滨道店」，城市还错挂在北京）。
 *
 * ## 判据：连续 N 轮「该配置成功抓取、但结果里没有它」
 *
 * 一轮抓取就是一次天然对账：某份配置成功跑完，它名下的门店却一家都没出现在
 * 本轮结果里 —— 说明上游那边这家店没了。攒够 `STUDIO_RETIRE_ROUNDS`（默认 3)轮
 * 才动手，单轮抖动（接口抽风、分页没翻完）不会误杀。
 *
 * ⚠ 三条硬保护，缺一不可：
 *   ① **只对「本轮真正成功抓取」的配置计数**。配置没跑/跑失败（引擎抛错 →
 *      runCrawl 失败 → 不会进 seenByConfig）就不计数 —— 否则平台停摆几天，
 *      它名下所有店都会被清光。
 *   ② **骤减保护**：库内 ≥3 家、本轮见到的不足一半 → 判为接口异常（改版/分页
 *      中断），整份配置本轮跳过。这条挡的是「一次改版清空整个平台」。
 *   ③ **只认抓取门店**：`lastSeenAt` 非空才算（只有 crawler/importer.js 会写它）。
 *      用户手录/补录的门店永远是 null → 本模块对它们彻底免疫。
 *
 * ## 退休是可逆的
 *
 * 退休 = `status=false`（列表/课表/搜索都看不见）+ 清掉今天及以后没人管的课，
 * 但记录本身还在。上游哪天把这家店加回来，`importer.resolveExistingStudio`
 * 会命中这条记录并置回可见，`seenPatch` 同时把 missedRounds 归零 —— 自动复活，
 * 不需要人干预。
 */
import { prisma } from "./prisma.js";
import { retireOneStudio } from "./retire-studios.js";
import { invalidateStudioIndex } from "./studio-index.js";
import { invalidateTimelineCache } from "../services/schedule.service.js";
// 复用「门店名 → 抓取配置」的匹配逻辑（前缀匹配 + 同城优先），别再抄一份
import { findConfig as findStudioCrawlConfig } from "./live-booking.js";

const DEFAULT_ROUNDS = 3;
/** 库内少于这么多家就不启用骤减保护（单店/双店配置本来就该「少」） */
const MIN_PLATFORM = 3;
/** 本轮见到的店数不足库内的这个比例 → 判为接口异常 */
const SHRINK_RATIO = 0.5;
/** 诊断响应里最多回多少条「正在计数」的店 */
const WATCH_LIMIT = 50;

/** 今天（UTC 午夜），与 Schedule.scheduleDate 的 @db.Date 同口径 */
function utcToday() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** 退休阈值（轮）。env 可调 —— 应急时调大就能把清退停下来，不用回滚代码。 */
export function retireRounds() {
  const n = Number(process.env.STUDIO_RETIRE_ROUNDS ?? DEFAULT_ROUNDS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_ROUNDS;
}

const SELECT = {
  id: true,
  name: true,
  cityId: true,
  status: true,
  missedRounds: true,
  lastSeenAt: true,
  lastCrawlConfigId: true,
};

/**
 * 列出「已达阈值、会被退休」的抓取门店。云端诊断用（免鉴权只读）。
 * 不依赖本轮抓取结果 —— 看的是库里已经攒下来的计数。
 */
export async function staleStudios({ rounds = retireRounds(), limit = 200 } = {}) {
  return prisma.studio.findMany({
    where: {
      status: true,
      lastSeenAt: { not: null },
      missedRounds: { gte: rounds },
    },
    select: SELECT,
    orderBy: { missedRounds: "desc" },
    take: limit,
  });
}

/**
 * 执行一次对账。
 *
 * @param {object} [opts]
 * @param {Map<string, string[]|{studios?: string[]}>} [opts.seenByConfig]
 *        本轮**成功抓取**的配置 → 该配置本轮见到的门店名。不传则只做
 *        「按已攒下的计数清退」（端点的预演/手动作业走这条路）。
 * @param {number} [opts.rounds] 退休阈值，默认 env / 3
 * @param {boolean} [opts.dryRun] 预演：只算不写（云端库不开公网，改生产数据必须能先看后动）
 * @param {(m: string) => void} [opts.log]
 * @returns {Promise<object>} 汇总 + 候选清单
 */
export async function reconcileStudios(opts = {}) {
  const log = opts.log || (() => {});
  const dryRun = !!opts.dryRun;
  const rounds = Number.isFinite(opts.rounds) && opts.rounds >= 1
    ? Math.floor(opts.rounds)
    : retireRounds();
  const seenByConfig = opts.seenByConfig instanceof Map ? opts.seenByConfig : null;
  const today = utcToday();

  let configsChecked = 0;
  let checked = 0;
  let bumped = 0;
  let skipped = 0;
  /** 达到阈值、将被（或已被）退休的 */
  const candidates = [];
  /** 正在计数、还没到阈值的 */
  const watch = [];

  // ── 第一部分：本轮见过谁 / 没见谁 ──────────────────────────────────
  if (seenByConfig) {
    for (const [configId, entry] of seenByConfig) {
      const names = Array.isArray(entry) ? entry : entry?.studios || [];
      // 本轮这份配置是什么时候开始抓的 —— 用来兜「importer 复用了库里那条
      // 名字**不一样**的记录」这种情况：配置生成器把店名从 `（上海）` 改成 `(上海)`，
      // resolveExistingStudio 会按归一化同名复用老记录且**不改名**（改名会让历史数据
      // 与配置对不上，是刻意不做的），于是 report.studios 里是新名字、库里存的是旧名字
      // —— 只按名字判会把这家店判成「没见到」，3 轮之后误清。
      const since = !Array.isArray(entry) && entry?.at instanceof Date ? entry.at : null;
      const owned = await prisma.studio.findMany({
        where: { lastCrawlConfigId: configId, status: true },
        select: SELECT,
      });
      if (!owned.length) continue;
      configsChecked += 1;

      const seenSet = new Set(names.map((n) => String(n || "").trim()).filter(Boolean));
      // 保护 ②：骤减保护 —— 疑接口异常，本轮整份配置跳过（不计数）
      if (owned.length >= MIN_PLATFORM && seenSet.size < owned.length * SHRINK_RATIO) {
        skipped += 1;
        log(
          `[reconcile] ${configId} 本轮只见到 ${seenSet.size} 家（库内 ${owned.length} 家），` +
            `疑似接口异常/分页中断 → 跳过本轮对账`,
        );
        continue;
      }

      for (const s of owned) {
        checked += 1;
        // 本轮见到了 → importer 已打点（重置计数），不用管
        if (seenSet.has(s.name)) continue;
        // 名字对不上但本轮确实被碰过（改名复用）→ 也算见到
        if (since && s.lastSeenAt instanceof Date && s.lastSeenAt.getTime() >= since.getTime() - 1000) {
          continue;
        }
        const next = (s.missedRounds || 0) + 1;
        if (!dryRun) {
          await prisma.studio.update({
            where: { id: s.id },
            data: { missedRounds: { increment: 1 } },
          });
        }
        bumped += 1;
        const row = { ...s, missedRounds: next };
        if (next >= rounds) candidates.push({ ...row, byRound: true });
        else if (watch.length < WATCH_LIMIT) watch.push(row);
      }
    }
  }

  // ── 第二部分：清退 —— 库内计数已达阈值的（含上一轮就达标的）────────
  const reached = await prisma.studio.findMany({
    where: {
      status: true,
      lastSeenAt: { not: null }, // 保护 ③：只认抓取门店
      missedRounds: { gte: rounds },
    },
    select: SELECT,
  });

  let retired = 0;
  let pruned = 0;
  const retiredNames = [];
  for (const s of reached) {
    candidates.push({ ...s, byRound: false });
    if (dryRun) continue;
    const r = await retireOneStudio(s, {
      today,
      log,
      reason: `抓取对账：连续 ${s.missedRounds} 轮未出现`,
    });
    retired += r.retired;
    pruned += r.pruned;
    if (r.retired) retiredNames.push(`#${s.id}「${s.name}」`);
  }

  if (retired) {
    invalidateStudioIndex();
    await invalidateTimelineCache().catch(() => {});
    log(`[reconcile] 僵尸门店退休 ${retired} 家（清未来课 ${pruned} 节）`);
  }

  return {
    rounds,
    dryRun,
    configsChecked,
    checked,
    bumped,
    skipped,
    retired,
    pruned,
    // 去重（同一家店可能既被本轮 bump 到阈值、又被第二部分的查询捞到）
    candidates: dedupeById(candidates),
    watch,
    retiredNames,
  };
}

function dedupeById(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * 归属回填 —— 三列上线时的一次性迁移（幂等，可反复跑）。
 *
 * ## 为什么必须有它
 *
 * 对账是「按 `lastCrawlConfigId` 找这家店归谁管，再看它本轮有没有出现」。
 * 而三列是新加的：存量门店这两个字段全是空 —— **僵尸店恰恰是那些再也不会被
 * 抓到的店**，它们永远不会被 importer 打点，也就永远进不了对账范围。
 * 结果是「最该被清的那批店反而最安全」，机制看着完美却不干活。
 *
 * 所以先给存量门店补一次归属：用 `live-booking.findConfig`（门店名 → 配置，
 * 前缀匹配 + 同城优先）打标。
 *
 * ## 基线时刻
 *
 * 打标的同时把 `lastSeenAt` 置为**此刻**：等价于声明「迁移这一刻，假定它们都还
 * 活着，从这一刻起开始计时」。不设基线的话，所有存量店的 lastSeenAt 都是空，
 * 而第二轮对账会把它们当成「从未出现过」—— 一次性清空全库。
 *
 * ## 谁能被回填 / 谁不能
 *
 * - ⚠ **只处理 platform=WECHAT**。用户手录/补录的店（platform=OTHER）绝不能被
 *   卷进来 —— 它们凑巧也可能叫「嘉禾舞社」而被前缀匹配命中，那样三轮之后会被
 *   当僵尸清掉，代价不可接受。宁可让海外抓取店（也是 OTHER）晚一轮才开始计时
 *   （它们在本轮被抓到时由 importer 打点，一样能进对账）。
 * - 匹配不到配置的店（自营品牌、配置已删、手录店）保持空 → **永远免疫**。
 *   这条也是天然的：没有归属就没有「该出现的名单」，自然判不了「没出现」。
 */
export async function backfillStudioOwnership(opts = {}) {
  const log = opts.log || (() => {});
  const now = new Date();

  const studios = await prisma.studio.findMany({
    where: { lastCrawlConfigId: null, status: true, platform: "WECHAT" },
    select: { id: true, name: true, city: { select: { name: true } } },
  });
  if (!studios.length) return { scanned: 0, filled: 0, unmatched: 0 };

  let filled = 0;
  let unmatched = 0;
  for (const s of studios) {
    const cfg = findStudioCrawlConfig(s.name, s.city?.name || "");
    if (!cfg) {
      unmatched += 1;
      continue;
    }
    await prisma.studio.update({
      where: { id: s.id },
      data: { lastCrawlConfigId: cfg.id, lastSeenAt: now },
    });
    filled += 1;
  }

  if (filled) {
    log(
      `[reconcile] 门店归属回填：${filled} 家挂上抓取配置（扫描 ${studios.length} 家，` +
        `${unmatched} 家匹配不到配置 → 不参与对账）`,
    );
  }
  return { scanned: studios.length, filled, unmatched };
}
