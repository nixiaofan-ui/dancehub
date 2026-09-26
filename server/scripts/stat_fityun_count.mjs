// 统计「菲体云链路」带来的可见工作室数（按 configs 里的门店名匹配）
// 用法：/usr/local/bin/node scripts/stat_fityun_count.mjs
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = path.dirname(fileURLToPath(import.meta.url));
const crawlerDir = path.resolve(here, "..", "src", "crawler");

const names = new Set();
const fityunFile = path.join(crawlerDir, "studios.fityun.json");
if (fs.existsSync(fityunFile)) {
  for (const c of JSON.parse(fs.readFileSync(fityunFile, "utf8"))) {
    for (const b of c.fityun?.branches || []) if (b.name) names.add(b.name.trim());
  }
}
// 手写的 4 条（Phoenix / Lohas / GH5 / RB Dance）门店名不在文件里，从 configs.js 里抓
const cfgSrc = fs.readFileSync(path.join(crawlerDir, "configs.js"), "utf8");
for (const m of cfgSrc.matchAll(/name:\s*"([^"]+)"/g)) names.add(m[1].trim());

const p = new PrismaClient();
const studios = await p.studio.findMany({
  select: { name: true, status: true, _count: { select: { schedules: true } } },
});
const hit = studios.filter((s) => names.has(s.name.trim()));
console.log(
  "配置里出现的门店名:",
  names.size,
  "| 已入库且可见:",
  hit.filter((s) => s.status).length,
  "| 课数合计:",
  hit.reduce((a, s) => a + s._count.schedules, 0)
);
await p.$disconnect();
