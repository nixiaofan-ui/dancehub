/**
 * 生成「门店 → 行政区」覆盖表：server/src/crawler/district-overrides.json
 *
 * 为什么需要它：库里 `Studio.address` 95% 是空的（北京 209 家只有 11 家有地址），
 * 于是「按行政区筛选」根本无从下手 —— 只能靠店名尾巴那个「（海淀）」，
 * 覆盖率只有三成（北京 36% / 上海 31%）。
 *
 * 好消息是上游有数据：菲云 `GET /org/orglist?orgid=X`（免登录，只要 orgid 头）
 * 给每家分店的**完整地址 + 经纬度**，地址里普遍带「朝阳区」「天河区」这种区名。
 * 这里批量回源，把「门店名 → 区名 + 地址 + 坐标」落成一份静态表，
 * 随代码一起上云，由启动时的 ensureDistrict() 回填进库。
 *
 * 为什么不放在服务端启动时现拉：590 家 = 590 次上游请求，每次冷启动都跑一遍
 * 太重，而且启动链上多一个外部依赖就多一个失败点。落静态表最稳。
 *
 * 用法：node scripts/build-district-overrides.mjs [--apply]
 *       默认 dry-run 只打印统计；--apply 才写文件。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { crawlerConfigs } from "../src/crawler/configs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../src/crawler/district-overrides.json");
const NAMES = JSON.parse(
  fs.readFileSync(path.resolve(HERE, "../src/crawler/district-names.json"), "utf8"),
);
/** { 城市名: [区名…] } —— 按城市分组，避免「万宁」这种短名在别的城市误命中 */
const DISTRICTS = NAMES;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15";

const SUFFIXES = ["新区", "特区", "区", "县", "市"];

/**
 * 从一整串地址里找区名。
 *
 * ⚠ 必须**按城市限定候选区名**：全国 2947 个区名里两字短名一大堆，
 * 不限城市的话「万宁」「七星」这种会撞上路名商圈名（北京没有万宁区）。
 *
 * 两档匹配：
 *   ① 「XX区 / XX县」带后缀 —— 最可靠，先验
 *   ② 裸名 —— 上游地址常写成「北京朝阳10号线惠新西街南口」这种不带「区」的，
 *      只认带后缀会漏掉一大半（实测 193/581 → 提升见下）
 */
function districtOf(address, city) {
  const a = String(address || "");
  if (!a) return "";
  const list = DISTRICTS[city] || [];
  for (const d of list) {
    if (d.length < 2) continue;
    for (const suf of SUFFIXES) {
      if (a.includes(d + suf)) return d;
    }
  }
  for (const d of list) {
    if (d.length >= 2 && a.includes(d)) return d;
  }
  return "";
}

const targets = crawlerConfigs.filter((c) => c.fityun && c.fityun.orgId);
console.log(`菲云配置 ${targets.length} 个，开始回源…`);

const out = {};
let ok = 0;
let withAddr = 0;
let withDistrict = 0;

/** 并发但要限流：上游扛不住几百个并发 */
async function pool(items, size, fn) {
  let i = 0;
  const workers = new Array(Math.min(size, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const cur = items[i++];
      await fn(cur).catch(() => {});
    }
  });
  await Promise.all(workers);
}

await pool(targets, 8, async (cfg) => {
  const orgId = String(cfg.fityun.orgId);
  const name = String(cfg.studio?.name || "").trim();
  const city = String(cfg.studio?.city || "").trim();
  if (!name) return;
  const resp = await fetch(
    "https://xiaochengxu-edu-api-hz.fityun.cn/org/orglist?lng=&lat=&city=&district=",
    { headers: { "User-Agent": UA, orgid: orgId }, signal: AbortSignal.timeout(15000) },
  );
  if (!resp.ok) return;
  const body = await resp.json();
  const list = Array.isArray(body?.info?.org_info) ? body.info.org_info : [];
  // 一个机构可能有好几家分店：优先取「地址里能认出区」的那条，
  // 认不出就退而取第一条有地址的 —— 连锁店总店地址通常最完整。
  const withD = list.find((b) => districtOf(b.address, city));
  const any = list.find((b) => String(b.address || "").trim());
  const pick = withD || any;
  if (!pick) return;
  ok++;
  const address = String(pick.address || "").trim();
  if (address) withAddr++;
  const district = districtOf(address, city);
  if (district) withDistrict++;
  out[`${city}|${name}`] = {
    address: address,
    district: district,
    lngLat: String(pick.lng_lat || "").trim(),
    source: "fityun-orglist",
  };
});

console.log(
  `回源成功 ${ok} 家（有地址 ${withAddr}、能定到区 ${withDistrict}）` +
    `，占菲云配置 ${Math.round((withDistrict / targets.length) * 100)}%`,
);

if (process.argv.includes("--apply")) {
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`已写入 ${OUT}`);
} else {
  console.log("[dry-run] 加 --apply 才写文件");
}
