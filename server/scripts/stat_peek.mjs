// 抽查某家店的课表（核对抓取内容是否正常）
// 用法：/usr/local/bin/node scripts/stat_peek.mjs "Phoenix" [条数]
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const kw = process.argv[2] || "Phoenix";
const limit = Number(process.argv[3] || 8);

// 库里 Time 字段以 1970-01-01 为锚点、按本地时区写入，取本地 HH:mm 才与门店一致
const hhmm = (d) =>
  d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "-";
const ymd = (d) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "-";

const st = await p.studio.findMany({ where: { name: { contains: kw } }, select: { id: true, name: true } });
if (!st.length) {
  console.log("未找到含关键字的门店:", kw);
  process.exit(0);
}
for (const s of st) {
  const rows = await p.schedule.findMany({
    where: { studioId: s.id },
    select: { scheduleDate: true, startTime: true, endTime: true, courseName: true, capacity: true, coach: { select: { name: true } } },
    orderBy: [{ scheduleDate: "asc" }, { startTime: "asc" }],
    take: limit,
  });
  console.log(`\n== #${s.id} ${s.name}（取前 ${limit} 条）==`);
  for (const r of rows) {
    console.log(
      `${ymd(r.scheduleDate)} ${hhmm(r.startTime)}-${hhmm(r.endTime)}  ${r.courseName}  @${r.coach?.name || "-"}  容量${r.capacity}`
    );
  }
}
await p.$disconnect();
