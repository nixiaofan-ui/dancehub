// 按关键字查工作室（核对 MAX POWER 等接入结果是否落在正确的记录上）
// 用法：/usr/local/bin/node scripts/stat_find.mjs <关键字...>
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const kws = process.argv.slice(2);
const rows = await p.studio.findMany({
  select: { id: true, name: true, status: true, address: true, _count: { select: { schedules: true } } },
  orderBy: { id: "asc" },
});
for (const s of rows) {
  if (!kws.length || kws.some((k) => s.name.toUpperCase().includes(k.toUpperCase()))) {
    console.log(`#${s.id}\t${s.status ? "可见" : "隐藏"}\t课数=${s._count.schedules}\t${s.name}\t${s.address || ""}`);
  }
}
await p.$disconnect();
