/**
 * 云端快照 vs 上游实时对比：证明「库里的数字是几小时前的快照」。
 * 用法：node scripts/diag-live.mjs [studioId] [cloudStudioId]
 */
import { crawlerConfigs } from "../src/crawler/configs.js";
import { crawl } from "../src/crawler/engine.js";
import { parseTimeRange } from "../src/crawler/mapper.js";

const HOST = "https://dancehub-server-317678-10-1493161376.sh.run.tcloudbase.com";
const DAY = 86400000;
const today = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const dateStr = new Date(today()).toISOString().slice(0, 10);
const hhmm = (t) =>
  t ? `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}` : "";

const cloudId = Number(process.argv[2] || 5);

// 1. 云端快照
const cloud = await fetch(
  `${HOST}/api/schedules?studioId=${cloudId}&from=${dateStr}&to=${dateStr}`,
).then((r) => r.json());
const rows = cloud?.data || [];
console.log(`云端 studioId=${cloudId} ${dateStr}：${rows.length} 节`);
const name = rows[0]?.studio?.name || "";
console.log("门店：", name);

// 2. 找本地抓取配置 + 实时回源
const cands = crawlerConfigs.filter((c) => {
  const base = String(c.studio?.name || "").trim();
  return name === base || name.startsWith(`${base}·`) || name.startsWith(`${base}（`);
});
console.log("匹配到配置：", cands.length, cands.map((c) => c.studio?.name).join("/"));
if (!cands.length) process.exit(0);
const cfg = cands[0];
const upstream = await crawl(cfg, new Date(today()));
console.log(`上游实时返回：${upstream.length} 条\n`);

const key = (t, n) => `${hhmm(parseTimeRange(t).startTime)}|${String(n).trim()}`;
const map = new Map(upstream.map((u) => [key(u.time, u.courseName), u]));

console.log("时间   课名                              云端快照   上游实时   容量");
let diff = 0,
  same = 0,
  miss = 0;
for (const r of rows) {
  const start = String(r.startTime || "").slice(0, 5);
  // 接口吐的 startTime 是北京时间，上游 crawl 出来的 Date 是 UTC → 回拨 8 小时再比
  const utcStart = `${String((Number(start.slice(0, 2)) - 8 + 24) % 24).padStart(2, "0")}:${start.slice(3, 5)}`;
  const u = map.get(`${utcStart}|${String(r.courseName).trim()}`);
  const live = u && u._bookedNum != null ? Number(u._bookedNum) : null;
  const snap = r.bookedNum;
  if (!u) miss++;
  else if (live === snap) same++;
  else diff++;
  const flag = !u ? "  (回源没匹配到)" : live !== snap ? "  ← 已变化" : "";
  console.log(
    `${start}  ${String(r.courseName).slice(0, 30).padEnd(32)} ${String(snap ?? "null").padStart(5)} ${String(live ?? "null").padStart(10)} ${String(r.capacity ?? "").padStart(6)}${flag}`,
  );
}
console.log(`\n一致 ${same} 节 / 已变化 ${diff} 节 / 回源未匹配 ${miss} 节`);
if (rows[0]?.updatedAt) console.log("云端数据最后写入：", rows[0].updatedAt);
