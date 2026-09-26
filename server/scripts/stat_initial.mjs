// 统计发现页工作室名称的首字符分布，用于设计「首字母分组 + 右侧索引条」。
// 用法：/usr/local/bin/node scripts/stat_initial.mjs
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const rows = await p.studio.findMany({
  where: { status: true },
  select: { name: true },
  orderBy: { id: "asc" },
});

console.log("可见工作室:", rows.length);

const first = new Map();
for (const r of rows) {
  const c = (r.name || "").trim().charAt(0);
  first.set(c, (first.get(c) || 0) + 1);
}
console.log("首字符种类数:", first.size);
console.log([...first.entries()].map(([c, n]) => `${c}(${n})`).join(" "));

const cn = rows.filter((r) => /^[\u4e00-\u9fa5]/.test((r.name || "").trim()));
console.log("\n中文开头的名字:", cn.length, "家");
for (const r of cn) console.log("  ", r.name);

const cnChars = [...new Set(cn.map((r) => (r.name || "").trim().charAt(0)))];
console.log("\n中文首字去重:", cnChars.length, "个 →", cnChars.join(""));

const other = rows.filter((r) => !/^[A-Za-z0-9\u4e00-\u9fa5]/.test((r.name || "").trim()));
if (other.length) {
  console.log("\n符号开头的名字:");
  for (const r of other) console.log("  ", JSON.stringify(r.name));
}

await p.$disconnect();
