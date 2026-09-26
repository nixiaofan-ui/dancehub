// 列出 status=false 但仍有课表的工作室（避免误隐藏有数据的店）
// 用法：/usr/local/bin/node scripts/stat_hidden.mjs
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const rows = await p.studio.findMany({
  where: { status: false },
  select: { id: true, name: true, address: true, _count: { select: { schedules: true } } },
  orderBy: { id: "asc" },
});
for (const s of rows) {
  console.log(
    `#${s.id}\t${s.name}\t课数=${s._count.schedules}\t${s.address || ""}`
  );
}
console.log("共", rows.length, "家被隐藏");
await p.$disconnect();
