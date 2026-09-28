// 当前库内数据快照：城市 / 舞室 / 课程 统计
// 用法：cd server && node scripts/stat_now.mjs
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const [studios, coaches, schedules] = await Promise.all([
  p.studio.count(),
  p.coach.count(),
  p.schedule.count(),
]);
const activeStudios = await p.studio.count({ where: { status: true } });
const cities = await p.city.findMany({
  select: { id: true, name: true, region: true, _count: { select: { studios: true } } },
  orderBy: { name: "asc" },
});
const withSched = await p.studio.groupBy({
  by: ["cityId"],
  _count: { _all: true },
  where: { schedules: { some: {} } },
});
const schedByCity = new Map(withSched.map((r) => [r.cityId, r._count._all]));

console.log("=== 总览 ===");
console.log("城市数:", cities.length);
console.log("舞室数:", studios, "(可见 status=true:", activeStudios + ")");
console.log("教练数:", coaches);
console.log("课程数:", schedules);

console.log("\n=== 按区域 ===");
const byRegion = {};
for (const c of cities) {
  byRegion[c.region] = (byRegion[c.region] || 0) + c._count.studios;
}
console.log(Object.entries(byRegion).map(([k, v]) => `${k}:${v}家`).join("  "));

console.log("\n=== 城市明细（按舞室数倒序）===");
cities
  .slice()
  .sort((a, b) => b._count.studios - a._count.studios)
  .forEach((c) => {
    console.log(
      `${c.name}(${c.region})`.padEnd(18),
      "舞室", String(c._count.studios).padStart(4),
      "有课", String(schedByCity.get(c.id) || 0).padStart(4)
    );
  });

await p.$disconnect();
