/**
 * 一次性清洗：抓取配置里「（市秦淮）」这种半截市名 → 「（秦淮）」。
 *
 * 成因见 src/lib/studio-name.js 的 fixCityPrefixDistrict —— 配置生成器早期
 * 从地址「江苏省南京市秦淮区…」里切区名时咬到了「市秦淮」。生成器正则已修，
 * 但**已生成并提交的配置文件**里的存量不会自己变，必须洗一遍再提交，
 * 否则下一轮抓取又会把脏名字写回库里（库里那 105 家由启动时的
 * src/lib/fix-data.js 洗，两边要用同一个函数，才不会一个洗一个不洗）。
 *
 * 用法：node scripts/fix-config-district-names.mjs [--apply]
 *       默认 dry-run，只打印改动；加 --apply 才落盘。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fixCityPrefixDistrict } from "../src/lib/studio-name.js";

const apply = process.argv.includes("--apply");
const crawlerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/crawler");

let totalFiles = 0;
let totalChanged = 0;

for (const file of fs.readdirSync(crawlerDir).filter((f) => f.endsWith(".json"))) {
  const full = path.join(crawlerDir, file);
  const raw = fs.readFileSync(full, "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    continue;
  }

  const nodes = [];
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      if (typeof o.name === "string") nodes.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(json);

  let changed = 0;
  for (const node of nodes) {
    const after = fixCityPrefixDistrict(node.name);
    if (after === node.name) continue;
    changed++;
    console.log(`${file}: ${node.name}  →  ${after}`);
    node.name = after;
  }
  if (!changed) continue;

  totalFiles++;
  totalChanged += changed;
  if (apply) {
    fs.writeFileSync(full, JSON.stringify(json, null, 2) + "\n", "utf8");
    console.log(`  ✔ 已写入 ${file}（${changed} 处）`);
  }
}

console.log(
  apply
    ? `\n已落盘：${totalFiles} 个文件、${totalChanged} 处`
    : `\n[dry-run] 共 ${totalFiles} 个文件、${totalChanged} 处待改（加 --apply 落盘）`,
);
