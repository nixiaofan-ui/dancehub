/**
 * 批量跑爱舞功平台的抓取配置（本机抓取 → 之后用 scripts/sync_cloud_db.sh 推上云）。
 *
 * 用法：
 *   node server/tools/run-aiwugong.mjs --city 深圳          # 只抓某城市
 *   node server/tools/run-aiwugong.mjs --all                # 全部启用
 *   node server/tools/run-aiwugong.mjs --ids 149,76,182     # 指定 brandId
 *   （可加 --dry 只看不写库）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCrawl } from "../src/crawler/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = path.resolve(__dirname, "../src/crawler/studios.aiwugong.json");

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const CITY = arg("city", "");
const IDS = arg("ids", "").split(",").map((s) => s.trim()).filter(Boolean);
const ALL = process.argv.includes("--all");
const DRY = process.argv.includes("--dry");

let list = JSON.parse(fs.readFileSync(CFG, "utf8")).filter((c) => c.enabled);
if (CITY) list = list.filter((c) => c.studio.city === CITY);
if (IDS.length) list = list.filter((c) => IDS.includes(String(c.aiwugong.brandId)));
if (!CITY && !IDS.length && !ALL) {
  console.error("请指定 --city 或 --ids，或显式加 --all");
  process.exit(1);
}

console.log(`共 ${list.length} 个配置待抓（dryRun=${DRY}）`);
let ok = 0, fail = 0, totalRows = 0, created = 0, updated = 0;
const t0 = Date.now();
const failed = [];
for (const c of list) {
  try {
    const r = await runCrawl(c.id, { dryRun: DRY });
    ok++;
    totalRows += r.total || 0;
    if (!DRY) {
      created += Object.values(r.created || {}).reduce((a, b) => a + b, 0);
      updated += Object.values(r.updated || {}).reduce((a, b) => a + b, 0);
    }
    process.stdout.write(`  ✔ ${c.label.slice(0, 20).padEnd(22)} ${r.total || 0} 条\n`);
  } catch (e) {
    fail++;
    failed.push({ id: c.id, err: e.message });
    process.stdout.write(`  ✘ ${c.label.slice(0, 20).padEnd(22)} ${e.message.slice(0, 60)}\n`);
  }
  if ((ok + fail) % 10 === 0) console.log(`  ...进度 ${ok + fail}/${list.length}（${Math.round((Date.now() - t0) / 1000)}s）`);
}

console.log(`\n完成：成功 ${ok} / 失败 ${fail}｜抓到 ${totalRows} 条｜新增 ${created}｜更新 ${updated}｜耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
if (failed.length) {
  console.log("失败清单：");
  failed.slice(0, 20).forEach((f) => console.log("  -", f.id, "|", f.err));
}
process.exit(0);
