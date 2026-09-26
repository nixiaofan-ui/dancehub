// 预览发现页的「首字母分组」排序结果。
// 用法：/usr/local/bin/node scripts/preview_sort.mjs [每组的样例数，默认全量]
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { sortStudiosByName, nameMeta } from "../src/services/studio-sort.service.js";

const limit = process.argv[2] ? Number(process.argv[2]) : Infinity;

const p = new PrismaClient();
const studios = await p.studio.findMany({ where: { status: true }, select: { id: true, name: true } });
const sorted = sortStudiosByName(studios);

console.log("可见工作室:", sorted.length);

const groups = new Map();
for (const s of sorted) {
  if (!groups.has(s.initial)) groups.set(s.initial, []);
  groups.get(s.initial).push(s.name);
}

console.log("分组数:", groups.size, "→", [...groups.keys()].join(" "));
console.log("");
for (const [letter, names] of groups) {
  const shown = names.slice(0, limit);
  const more = names.length > limit ? ` …(+${names.length - limit})` : "";
  console.log(`[${letter}] (${names.length}) ${shown.join(" / ")}${more}`);
}

// 抽查排序是否真的有序（必须用真实的排序键比较，拿汉字原名比大小没有意义）
let bad = 0;
for (const [letter, names] of groups) {
  const keys = names.map((n) => nameMeta(n).sortKey);
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1] > keys[i]) {
      bad++;
      console.log(`  ⚠ [${letter}] 组内逆序: ${names[i - 1]} (${keys[i - 1]}) > ${names[i]} (${keys[i]})`);
    }
  }
}
console.log("\n组内逆序条目:", bad);

await p.$disconnect();
