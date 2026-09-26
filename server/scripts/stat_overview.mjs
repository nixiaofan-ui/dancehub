// 一次性数据概览：工作室 / 教练 / 课表 统计
// 用法（必须在 server 目录、用 x64 node）：/usr/local/bin/node scripts/stat_overview.mjs
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const studios = await p.studio.findMany({
  select: { name: true, status: true, _count: { select: { schedules: true } } },
});
const active = studios.filter((s) => s.status);
const withSched = studios.filter((s) => s._count.schedules > 0);

console.log("工作室总数:", studios.length);
console.log("发现页可见(status=true):", active.length);
console.log("当前有排课:", withSched.length);
console.log("课表总条数:", studios.reduce((a, s) => a + s._count.schedules, 0));
console.log("教练数:", await p.coach.count());

const dates = await p.schedule.groupBy({
  by: ["scheduleDate"],
  _count: { _all: true },
  orderBy: { scheduleDate: "asc" },
});
console.log(
  "日期分布:",
  dates.map((d) => `${String(d.scheduleDate).slice(0, 10)}(${d._count._all})`).join(" ")
);

const names = await p.schedule.findMany({ select: { courseName: true }, distinct: ["courseName"] });
console.log("不同课名数:", names.length);

await p.$disconnect();
