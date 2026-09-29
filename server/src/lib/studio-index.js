import { prisma } from "./prisma.js";

/**
 * 门店归一化索引 —— 进程内的一份「去掉所有标点/空格后」的门店名与地址。
 *
 * 为什么需要它：`fuzzySearchStudio` 的探针前缀是在**归一化串**上截的，
 * 拿去 DB 做 `contains` 时匹配的却是**原始店名**，两者对不上就捞不到候选。
 * 最典型的是连字符：`t-rex dance` 归一化成 `trexdance`，前缀 `tre` 在原串里
 * 根本不连续（t、-、r），探针直接落空 —— 用户搜 `trex` 得到 0 结果（2026-09-29 修）。
 *
 * DB 侧表达不了「忽略分隔符后再 contains」（要 REPLACE 原生 SQL，会锁死数据库方言），
 * 所以这份索引里的串本就归一化过，命中判断全在 JS 里做。
 *
 * 规模：全库几千家门店、每条记录三个短字段，内存几百 KB；全表扫一遍是毫秒级。
 * 只在「DB 精确 contains」落空后才被查询，正常搜索路径零额外开销。
 */

const TTL_MS = 10 * 60 * 1000;

let cache = null;
let inflight = null;

/** 只留字母 / 数字 / 汉字，统一小写 */
export function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

async function load() {
  const rows = await prisma.studio.findMany({
    select: { id: true, name: true, address: true, cityId: true, status: true },
  });
  return rows
    .map((r) => ({ ...r, n: normName(r.name), a: normName(r.address) }))
    .filter((r) => r.n.length >= 2);
}

/** 取索引（带 TTL 与并发合并：同时来 10 个请求只查一次库） */
export async function getStudioIndex() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  if (inflight) return inflight;
  inflight = load()
    .then((rows) => {
      cache = { at: Date.now(), rows };
      inflight = null;
      return rows;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

/** 抓取/补录写入门店后调用，让下一次搜索立刻看到新店 */
export function invalidateStudioIndex() {
  cache = null;
}

/**
 * 全表归一化搜索，返回匹配的门店 id（按匹配质量降序）。
 *
 * 三种命中，优先级递减：
 *   2 = 店名归一化后以关键词开头（搜 `trex` 命中 `t-rex dance`）
 *   1 = 店名归一化后包含关键词
 *   0 = 反向包含：用户把全名打全了（`gh5dancestudio`），库里反而只有品牌名（`gh5`）。
 *       只在库名够长（>= 4）时认，否则「舞」这种一字 needle 会反查出半个库。
 *
 * 地址也算，因为「XX舞蹈（高新店）」这类店名常常不带城市/区名，用户会拿地址里的地名搜。
 *
 * `keywords` 接受多个变体（原文 + 剥掉 dance/studio 这类通名尾巴后的品牌本体），
 * 因为库里店名习惯是「品牌 + 分店/区名」（`GH5·中山公园店（长宁）`），和用户输入的
 * 顺序/长度都不一致 —— 只拿原串比，`GH5DanceStudio` 是永远匹配不上 `gh5中山公园店长宁` 的。
 *
 * @param {string | string[]} keywords
 * @param {{cityId?: number, onlyActive?: boolean, limit?: number}} [opts]
 * @returns {Promise<number[]>}
 */
export async function searchStudioIdsByNorm(keywords, opts = {}) {
  const needles = (Array.isArray(keywords) ? keywords : [keywords])
    .map(normName)
    .filter((n) => n.length >= 2);
  if (!needles.length) return [];
  // 长的放前面：更具体的变体先命中就不用再看短的
  needles.sort((a, b) => b.length - a.length);

  const rows = await getStudioIndex();
  const limit = opts.limit || 200;

  const hit = [];
  for (const r of rows) {
    if (opts.onlyActive && !r.status) continue;
    if (opts.cityId && r.cityId !== opts.cityId) continue;

    let best = -1;
    let bestLen = 0;
    for (const needle of needles) {
      let sc = -1;
      if (r.n.startsWith(needle)) sc = 2;
      else if (r.n.includes(needle)) sc = 1;
      else if (r.a && r.a.includes(needle)) sc = 0;
      else if (r.n.length >= 4 && needle.includes(r.n)) sc = 0;
      if (sc > best) {
        best = sc;
        bestLen = needle.length;
      }
      if (best === 2) break;
    }
    // 同档命中里，被更长的 needle 命中的更可信（`gh5` 会撞出泛匹配，`gh5dancestudio` 不会）
    if (best >= 0) hit.push({ id: r.id, score: best * 100 + Math.min(bestLen, 99) });
  }

  hit.sort((a, b) => b.score - a.score);
  return hit.slice(0, limit).map((h) => h.id);
}
