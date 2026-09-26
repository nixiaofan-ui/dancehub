// 统计课名首尾带多余「.」的脏数据（菲体云风格）
// 用法：/usr/local/bin/node scripts/stat_dotnames.mjs [--fix]
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const fix = process.argv.includes("--fix");

// 必须与 crawler/engine.js 的 cleanCourseName 完全一致，
// 否则下一次抓取算出的幂等键对不上，会插出重复课。
const clean = (s) =>
  String(s ?? "")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");

const rows = await p.schedule.findMany({
  select: { id: true, courseName: true, studio: { select: { name: true } } },
});
const dirty = rows.filter((r) => clean(r.courseName) !== r.courseName);
console.log("课表总条数:", rows.length, "| 课名需清洗:", dirty.length);

const samples = [...new Set(dirty.map((r) => r.courseName))].slice(0, 20);
console.log("样例:", samples.map((s) => JSON.stringify(s)).join(" "));

if (fix) {
  let n = 0;
  for (const r of dirty) {
    const name = clean(r.courseName);
    if (!name) continue;
    await p.schedule.update({ where: { id: r.id }, data: { courseName: name } });
    n++;
  }
  console.log("已清洗:", n, "条");
}
await p.$disconnect();
