/**
 * 抽查：有预告的店，预告地址是不是真的活着（不只是上游给了个标记）。
 * 走的是线上同一套代码路径：crawl() → videoRef → services/fityun-video.js → 回源。
 * 用法：cd server && /usr/local/bin/node tools/probe-video-live.mjs
 */
import { crawl } from "../src/crawler/engine.js";
import { crawlerConfigs } from "../src/crawler/configs.js";
import { getFityunVideoUrl } from "../src/services/fityun-video.js";

const targets = ["fityun-11058641", "fityun-11056845", "fityun-11053930", "fityun-11053848", "fityun-11050574"];
const date = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

for (const id of targets) {
  const c = crawlerConfigs.find((x) => x.id === id);
  if (!c) {
    console.log(`? 找不到配置 ${id}`);
    continue;
  }
  const rows = await crawl(c, date);
  const withVideo = rows.filter((r) => r._videoRef);
  console.log(`\n■ ${c.studio.name}（${id}） 今日 ${rows.length} 节，其中 ${withVideo.length} 节有预告`);
  for (const r of withVideo.slice(0, 2)) {
    const url = await getFityunVideoUrl(r._videoRef);
    let probe = "(无地址)";
    if (url) {
      try {
        const h = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
        probe = `HTTP ${h.status} ${h.headers.get("content-type") || ""} ${h.headers.get("content-length") || "?"}B`;
      } catch (e) {
        probe = `HEAD 失败 ${e.message}`;
      }
    }
    console.log(`   ${r.startTime || ""} ${r.courseName}`);
    console.log(`     ref=${r._videoRef}`);
    console.log(`     url=${url ? url.slice(0, 90) + "…" : ""}`);
    console.log(`     实测 ${probe}`);
  }
}
