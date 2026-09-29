/**
 * 预约人数体检：① 库里覆盖率（按平台）② 抽样回源，比对库值 vs 上游实时值。
 * 只读 + 少量写（不写库），用于定位「人数不准」到底不准在哪。
 */
import { prisma } from "../src/lib/prisma.js";
import { crawlerConfigs } from "../src/crawler/configs.js";
import { crawl } from "../src/crawler/engine.js";
import { parseTimeRange } from "../src/crawler/mapper.js";

const DAY = 86400000;
const todayUTC = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const hhmm = (t) => {
  if (!t) return "";
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
};

async function coverage() {
  const from = new Date(todayUTC());
  const to = new Date(todayUTC() + 7 * DAY);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT st.platform AS platform,
            COUNT(*) AS total,
            SUM(CASE WHEN sc.bookedNum IS NOT NULL THEN 1 ELSE 0 END) AS hasBooked,
            SUM(CASE WHEN sc.capacity IS NOT NULL AND sc.capacity <> '' THEN 1 ELSE 0 END) AS hasCap
     FROM Schedule sc JOIN Studio st ON st.id = sc.studioId
     WHERE sc.scheduleDate >= ? AND sc.scheduleDate <= ?
     GROUP BY st.platform ORDER BY total DESC`,
    from,
    to,
  );
  console.log("=== 未来 7 天预约人数覆盖率（按平台）===");
  let T = 0,
    B = 0;
  for (const r of rows) {
    const total = Number(r.total);
    const has = Number(r.hasBooked);
    T += total;
    B += has;
    console.log(
      `${String(r.platform).padEnd(10)} 课 ${String(total).padStart(6)}  有已约数 ${String(has).padStart(6)} (${((has / total) * 100).toFixed(1)}%)  有容量 ${Number(r.hasCap)}`,
    );
  }
  console.log(`合计 ${T} 节，有已约数 ${B} (${((B / T) * 100).toFixed(1)}%)`);
}

function findConfig(studioName, cityName) {
  const name = String(studioName || "").trim();
  const cands = crawlerConfigs.filter((c) => {
    if (!c.enabled) return false;
    const base = String(c.studio?.name || "").trim();
    if (!base) return false;
    return name === base || name.startsWith(`${base}·`) || name.startsWith(`${base}（`);
  });
  if (!cands.length) return null;
  if (cityName) {
    const same = cands.find((c) => String(c.studio?.city || "").trim() === cityName);
    if (same) return same;
  }
  return cands[0];
}

async function sample() {
  // 每平台抽 1 家今天有课的店
  const rows = await prisma.$queryRawUnsafe(
    `SELECT st.id, st.name, st.platform, st.cityId, COUNT(*) AS n
     FROM Schedule sc JOIN Studio st ON st.id = sc.studioId
     WHERE sc.scheduleDate = ?
     GROUP BY st.id, st.name, st.platform, st.cityId
     ORDER BY n DESC`,
    new Date(todayUTC()),
  );
  const byPlatform = new Map();
  for (const r of rows) {
    const p = r.platform || "?";
    if (!byPlatform.has(p)) byPlatform.set(p, []);
    if (byPlatform.get(p).length < 2) byPlatform.get(p).push(r);
  }

  console.log("\n=== 抽样回源：库值 vs 上游实时 ===");
  for (const [platform, list] of byPlatform) {
    for (const r of list) {
      const studio = await prisma.studio.findUnique({
        where: { id: Number(r.id) },
        include: { city: true },
      });
      const cfg = findConfig(studio.name, studio.city?.name);
      if (!cfg) {
        console.log(`[${platform}] ${studio.name} → 未匹配到抓取配置（回源不可用）`);
        continue;
      }
      let upstream = [];
      try {
        upstream = await crawl(cfg, new Date(todayUTC()));
      } catch (e) {
        console.log(`[${platform}] ${studio.name} → 回源失败: ${e.message}`);
        continue;
      }
      const db = await prisma.schedule.findMany({
        where: { studioId: studio.id, scheduleDate: new Date(todayUTC()) },
        select: { courseName: true, startTime: true, bookedNum: true, capacity: true },
      });
      let matched = 0,
        diff = 0,
        nullBefore = 0,
        nullAfter = 0;
      const samples = [];
      for (const s of db) {
        const start = hhmm(s.startTime);
        const hit = upstream.find((u) => {
          const t = parseTimeRange(u.time).startTime;
          return hhmm(t) === start && String(u.courseName).trim() === String(s.courseName).trim();
        });
        if (!hit) continue;
        matched++;
        const live = hit._bookedNum != null ? Number(hit._bookedNum) : null;
        if (s.bookedNum == null) nullBefore++;
        if (live == null) nullAfter++;
        if (live != null && s.bookedNum != null && live !== s.bookedNum) {
          diff++;
          if (samples.length < 3)
            samples.push(`${start} ${s.courseName}: 库 ${s.bookedNum} → 实时 ${live}`);
        }
        if (live != null && s.bookedNum == null && samples.length < 3)
          samples.push(`${start} ${s.courseName}: 库 null → 实时 ${live}`);
      }
      console.log(
        `[${platform}] ${studio.name}：库 ${db.length} 节 / 上游 ${upstream.length} 条 / 匹配 ${matched} 节 / 数值不同 ${diff} 节 / 库里缺值 ${nullBefore} 节` +
          (samples.length ? `\n    例：${samples.join(" | ")}` : ""),
      );
    }
  }
}

await coverage();
await sample();
await prisma.$disconnect();
