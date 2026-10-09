/**
 * 门店改名自愈（幂等，可重复执行）。
 *
 * 场景：抓取配置里的 `studio.name` 改了（去掉多余的分店后缀、订正品牌写法），
 * 库里那条记录还挂着旧名字，两边对不上。
 *
 * ⚠ 为什么必须改库、不能只改配置：importer 找店靠 `resolveExistingStudio` 的
 *   「精确同名 → 归一化同名」两档，旧名两档都命中不了 → 下一轮抓取把同一家店
 *   **再建一条**。用户看到两家同名门店，课表是两条记录的并集，其中一条从此
 *   不再更新（G-STEPS 城市校准那次就是只改 cityId 不改名踩的，见
 *   calibrate-gsteps-city.js）。
 *
 * ⚠ 为什么不把「旧名 → 新名」硬编码在这个文件里：改名的事实属于那家店自己的配置。
 *   配置里在 `studio` 上加一行 `legacyNames: ["旧名"]`（多分店配置写在
 *   `branches[].legacyNames`），本模块扫一遍 `src/crawler/studios.*.json` 就能对齐 ——
 *   以后任何一家店改名都只动配置，不必再写一个自愈脚本、也不会漏掉云端。
 *
 * ⚠ 只认「同城 + 旧名完全一致」：改名不可逆，模糊匹配改错一户，那家店的
 *   课表、关注、提醒就整批挪到别人名下了。
 *
 * ⚠ 撞名跳过：库里已经存在目标名字（多半是另一份配置早建好的同一条记录），
 *   直接改过去会撞车 —— 交给 maybeDedupeStudios 合并，这里不动手。
 *
 * 挂在启动流程里（而不是只做手工脚本）的原因：云端库没有公网入口，为了跑一次
 * 改名去开云库公网不划算；而配置是随代码上云的静态文件，云端重启一次就自动追平。
 * 抓取流程（crawler/index.js 的 tick）也会喊一次当保险，确保「改名」永远早于
 * 「抓取认店」，见那里 tick 开头的注释。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./prisma.js";
import { invalidateStudioIndex } from "./studio-index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRAWLER_DIR = path.resolve(HERE, "../crawler");

/**
 * 收集「同城旧名 → 现名」清单，来自 src/crawler/studios.*.json。
 *
 * 店名可能写在两处：
 *   1. `studio.name` —— 单店配置（魔方约课、styd、iWOD 手写配置…）
 *   2. `<平台>.branches[].name` —— 一次抓全连锁的多分店配置（菲体云、爱舞功…），
 *      这里不写死平台名，谁有 branches 数组就扫谁
 *
 * @param {string} [dir] 配置目录（烟测可指向临时目录）
 * @returns {{ city: string, name: string, legacy: string }[]}
 */
export function collectRenames(dir = CRAWLER_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^studios\..+\.json$/.test(f));
  } catch {
    return []; // 目录不在（打包裁剪）就别让启动流程挂掉
  }

  const out = [];
  const push = (city, name, legacy) => {
    const c = String(city || "").trim();
    const to = String(name || "").trim();
    if (!c || !to) return;
    for (const l of Array.isArray(legacy) ? legacy : []) {
      const from = String(l || "").trim();
      // 旧名写成了现名（配置里留了个没用的尾巴）直接跳过：
      // 留着的话每轮都要白查一次库，而且「给自己改名」本身就说不通
      if (from && from !== to) out.push({ city: c, name: to, legacy: from });
    }
  };

  for (const f of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    for (const cfg of Array.isArray(json) ? json : json.studios || []) {
      if (!cfg || !cfg.studio) continue;
      const city = cfg.studio.city;
      push(city, cfg.studio.name, cfg.studio.legacyNames);
      for (const v of Object.values(cfg)) {
        if (!v || !Array.isArray(v.branches)) continue;
        for (const b of v.branches) push(city, b && b.name, b && b.legacyNames);
      }
    }
  }
  return out;
}

/**
 * 一个进程只跑一次；抓取流程会再喊一次当保险，所以**成功后才置位** ——
 * 中途抛错时下一次 tick 还要能重试（置位提前会导致改名永远没跑）。
 */
let done = false;

/**
 * @param {{ log?: (msg: string) => void, force?: boolean, dir?: string }} [opts]
 * @returns {Promise<{ checked: number, changed: number, skipped: number }>}
 */
export async function renameStudios(opts = {}) {
  const force = !!opts.force;
  if (done && !force) return { checked: 0, changed: 0, skipped: 0 };

  const log = opts.log || (() => {});
  const pairs = collectRenames(opts.dir);
  let changed = 0;
  let skipped = 0;

  for (const r of pairs) {
    const city = await prisma.city.findFirst({
      where: { name: r.city },
      select: { id: true },
    });
    // 城市都没建过 = 这家店还没入库，什么都不用做
    if (!city) {
      skipped += 1;
      continue;
    }

    const rows = await prisma.studio.findMany({
      where: { cityId: city.id, name: r.legacy },
      select: { id: true, name: true },
    });
    // 查不到就是「已经改过了」—— 幂等的稳态，每次重启都走这一条
    if (!rows.length) continue;

    for (const s of rows) {
      const clash = await prisma.studio.findFirst({
        where: { cityId: city.id, name: r.name, id: { not: s.id } },
        select: { id: true },
      });
      if (clash) {
        skipped += 1;
        log(
          `[rename] #${s.id}「${r.legacy}」→「${r.name}」会撞上 #${clash.id}，` +
            `跳过（交给重复门店自愈）`,
        );
        continue;
      }
      await prisma.studio.update({ where: { id: s.id }, data: { name: r.name } });
      changed += 1;
      log(`[rename] #${s.id}（${r.city}）「${r.legacy}」→「${r.name}」`);
    }
  }

  done = true;

  if (changed) {
    // 搜索走的是进程内归一化索引（TTL 10min）：不主动失效的话，
    // 用户在这几分钟里拿新名字搜仍然是 0 条（旧名字反而还搜得到）
    invalidateStudioIndex();
    log(`[rename] 门店改名：改了 ${changed} 家`);
  }
  return { checked: pairs.length, changed, skipped };
}
