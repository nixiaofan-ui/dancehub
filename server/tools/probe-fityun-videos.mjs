/**
 * 探针：菲体云门店「课程预告视频」覆盖情况。
 *
 * 为什么需要它：课程预告是**上游按课**挂的（课表接口只回 `has_video=1` 这个标记），
 * 库里 `Schedule.videoRef` 也只在抓到的那些课上才有值。所以「哪些店有预告」没法
 * 从配置或平台名推出来，只能挨家问一遍上游。
 *
 * 用法：
 *   cd server && /usr/local/bin/node tools/probe-fityun-videos.mjs [城市1,城市2 ...] [天数]
 * 默认：城市 = 上海,北京，天数 = 3（今天 / +1 / +2）
 *
 * 输出：有预告的店（含课名）→ 有课但没预告的店 → 拉不到课的店。
 * 只读，不写库。
 */
import { crawl } from "../src/crawler/engine.js";
import { crawlerConfigs } from "../src/crawler/configs.js";

const cities = (process.argv[2] || "上海,北京").split(",").map((s) => s.trim()).filter(Boolean);
const DAYS = Number(process.argv[3] || 3);
const CONCURRENCY = 6;

/** 取今天起 N 天的日期串（UTC 日，和引擎保持一致） */
function dates(n) {
  const out = [];
  const base = Date.now();
  for (let i = 0; i < n; i++) out.push(new Date(base + i * 86400000).toISOString().slice(0, 10));
  return out;
}

const all = crawlerConfigs.filter((c) => c.mode === "fityun" && c.enabled !== false);
// 城市传 ALL 时扫全量（用来兜底「配置里城市标错、真店在别的城市」的情况）
const picked = cities.includes("ALL") ? all : all.filter((c) => cities.includes(c.studio?.city));

// 同一个 orgId 可能被多个文件重复收录（fityun.json / newdance.json / topcities.json），
// 去重后再问上游，省一半请求。
const byOrg = new Map();
for (const c of picked) {
  const key = String(c.fityun?.orgId || c.id);
  if (!byOrg.has(key)) byOrg.set(key, []);
  byOrg.get(key).push(c);
}
const targets = [...byOrg.entries()];
console.log(
  `城市 ${cities.join("/")}：配置 ${picked.length} 条 → 去重后 ${targets.length} 个机构，` +
    `扫 ${DAYS} 天（${dates(DAYS).join(", ")}）\n`,
);

const ds = dates(DAYS);
let cursor = 0;
const results = [];

async function work() {
  while (cursor < targets.length) {
    const [orgId, configs] = targets[cursor++];
    const c = configs[0];
    const rec = {
      orgId,
      configIds: configs.map((x) => x.id),
      city: c.studio?.city,
      names: [...new Set(configs.map((x) => x.studio?.name))],
      branches: (c.fityun?.branches || []).map((b) => b.name || b.id),
      courses: 0,
      videos: 0,
      videoCourses: new Set(),
      // 按「实际上游门店名」再分一层：一条配置可能带多个分店（branches），
      // 预告只挂在其中某几家身上，按配置聚合会看不出是哪一家。
      perBranch: new Map(),
      err: null,
    };
    try {
      for (const d of ds) {
        const rows = await crawl(c, new Date(`${d}T00:00:00Z`));
        rec.courses += rows.length;
        for (const r of rows) {
          const bn = r._studioName || c.studio?.name || "";
          if (!rec.perBranch.has(bn)) rec.perBranch.set(bn, { courses: 0, videos: 0, names: new Set() });
          const b = rec.perBranch.get(bn);
          b.courses += 1;
          if (r._videoRef) {
            rec.videos += 1;
            rec.videoCourses.add(r.courseName);
            b.videos += 1;
            b.names.add(r.courseName);
          }
        }
      }
    } catch (err) {
      rec.err = err.message;
    }
    results.push(rec);
    process.stderr.write(`\r扫完 ${results.length}/${targets.length} …`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, work));
process.stderr.write("\n\n");

const withVideo = results.filter((r) => r.videos > 0).sort((a, b) => b.videos - a.videos);
const noVideo = results.filter((r) => r.videos === 0 && r.courses > 0);
const dead = results.filter((r) => r.courses === 0);

console.log(`\n=== 有课程预告的店：${withVideo.length} 个机构 / ${withVideo.reduce((n, r) => n + [...r.perBranch.values()].filter((b) => b.videos > 0).length, 0)} 家门店 ===`);
for (const r of withVideo) {
  console.log(`■ ${r.names.join(" / ")}（${r.city}｜org ${r.orgId}）  预告课 ${r.videos}/${r.courses} 节`);
  for (const [bn, b] of [...r.perBranch].sort((a, b2) => b2[1].videos - a[1].videos)) {
    if (b.videos > 0) console.log(`   ▸ ${bn}：${b.videos}/${b.courses} 节 → ${[...b.names].join(" ｜ ")}`);
  }
}

console.log(`\n=== 有课但整店没有预告：${noVideo.length} 个机构 ===`);
for (const r of noVideo.slice(0, 25)) {
  console.log(`· ${r.names.join(" / ")}（${r.city}｜org ${r.orgId}）  ${r.courses} 节`);
}
if (noVideo.length > 25) console.log(`  …另有 ${noVideo.length - 25} 个`);

console.log(`\n=== 拉不到课（空课表/接口异常）：${dead.length} 个机构 ===`);
for (const r of dead) {
  console.log(
    `· ${r.names.join(" / ")}（${r.city}｜org ${r.orgId}）${r.err ? ` ⚠ ${r.err}` : ""}`,
  );
}
