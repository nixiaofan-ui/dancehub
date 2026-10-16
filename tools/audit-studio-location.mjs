/**
 * 门店地理位置体检（只读，不改任何数据）。
 *
 * 用户看到的症状是「我在北京列表里翻到一家 2000 公里外的店」。成因有四类，
 * 这个脚本把它们分开报 —— 因为**修法完全不同**：
 *
 *   ① 城市挂错，且地址里写明了正确城市   → calibrate 的地址判据会自动修（硬错误）
 *   ② 城市挂错，地址读不出城市（只有路名）→ calibrate 的坐标判据能修大部分；
 *      城市太小没有参考点的要进 city-overrides.json（人工核定）
 *   ③ 坐标错（城市对、坐标落在别的城市）  → **不能自动修**：分不清是坐标错还是地址错，
 *      要人工核实。自动改会把好店搬到错城市
 *   ④ 正常的「大市域远郊」               → 不该改（重庆万州离主城 222km 仍是重庆）
 *
 * 判定用「城市参考点」= 该城有坐标门店的**中位数坐标**（抗离群）。中位数不怕少数错店，
 * 所以不会因为城里混了几家错店就把参考点带跑（实测：广州 52 家里混 11 家深圳店，
 * 参考点依然稳在广州）。
 *
 * 跑法：
 *   cd server && /usr/local/bin/node ../tools/audit-studio-location.mjs
 * 只看汇总（CI/日常巡检）：
 *   cd server && /usr/local/bin/node ../tools/audit-studio-location.mjs --summary
 */
import { prisma } from "../server/src/lib/prisma.js";
import { cityFromAddress } from "../server/src/lib/city-names.js";

/** 离本城参考点超过这个距离 → 值得看一眼 */
const SUSPECT_KM = 80;
/** 离另一座城的参考点在这个距离内 → 基本可断定它属于那座城 */
const OTHER_CITY_KM = 25;
/** 离另一座城参考点在这个距离内 → 坐标「贴着」那座城，与自己的城市归属至少有一处是错的 */
const NEAR_CITY_KM = 80;
/** 参考点样本下限与内聚度下限（同 calibrate-studio-city.js，口径必须一致） */
const REF_MIN_SAMPLE = 3;
const REF_COHESION = 0.7;
/** 中国大致范围（同 fill-latlng.js），越界的是脏坐标 */
const LAT_RANGE = [3, 54];
const LNG_RANGE = [73, 136];

const SUMMARY_ONLY = process.argv.includes("--summary");

function haversine(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const studios = await prisma.studio.findMany({
  where: { status: true },
  select: { id: true, name: true, cityId: true, address: true, district: true, lat: true, lng: true },
});
const cities = await prisma.city.findMany({ select: { id: true, name: true, region: true } });
const cname = new Map(cities.map((c) => [c.id, c.name]));
const cregion = new Map(cities.map((c) => [c.id, c.region]));

// 参考点
const byCity = new Map();
for (const s of studios) {
  if (cregion.get(s.cityId) !== "CN") continue;
  if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
  if (!byCity.has(s.cityId)) byCity.set(s.cityId, []);
  byCity.get(s.cityId).push(s);
}
const refs = new Map();
const weakRefs = [];
for (const [cid, arr] of byCity) {
  if (arr.length < REF_MIN_SAMPLE) continue;
  const ref = { lat: median(arr.map((s) => s.lat)), lng: median(arr.map((s) => s.lng)), n: arr.length };
  ref.cohesion = arr.filter((s) => haversine(s, ref) <= SUSPECT_KM).length / arr.length;
  if (ref.cohesion < REF_COHESION) weakRefs.push({ name: cname.get(cid), ...ref });
  else refs.set(cid, ref);
}

const badAddr = [];   // ① 地址写明城市 ≠ 当前城市
const badCoord = [];  // ② 城市错 + 坐标能定性 / ③ 坐标错
const outOfRange = [];
let withCoord = 0;
let addrReadable = 0;

for (const s of studios) {
  if (cregion.get(s.cityId) !== "CN") continue;
  const cur = cname.get(s.cityId);
  const stated = cityFromAddress(s.address);
  if (stated) addrReadable += 1;
  if (stated && stated !== cur) {
    badAddr.push({ id: s.id, name: s.name, cur, stated, addr: s.address, district: s.district });
  }
  if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
  withCoord += 1;
  if (
    s.lat < LAT_RANGE[0] || s.lat > LAT_RANGE[1] ||
    s.lng < LNG_RANGE[0] || s.lng > LNG_RANGE[1]
  ) {
    outOfRange.push({ id: s.id, name: s.name, cur, lat: s.lat, lng: s.lng });
    continue;
  }
  const self = refs.get(s.cityId);
  if (!self) continue;
  const dSelf = haversine(s, self);
  if (dSelf <= SUSPECT_KM) continue;

  let nearest = null;
  for (const [cid, ref] of refs) {
    if (cid === s.cityId) continue;
    const d = haversine(s, ref);
    if (!nearest || d < nearest.d) nearest = { name: cname.get(cid), d };
  }

  // 四类分开报，「修法完全不同」是这张表存在的理由
  let kind, tag;
  if (nearest && nearest.d <= OTHER_CITY_KM && !stated) {
    // 离某座城极近、地址又读不出城市 → 它其实属于那座城，calibrate 可自动改
    kind = "city";
    tag = `城市可能应为 ${nearest.name}（${Math.round(nearest.d)}km）`;
  } else if (nearest && nearest.d <= NEAR_CITY_KM) {
    // 坐标紧贴另一座城，但地址写着本城 → 坐标与地址自相矛盾（改坐标还是改城市要人判）
    kind = "coord";
    tag = stated
      ? `⚠ 坐标与地址矛盾：地址写「${cur}」，坐标却贴着「${nearest.name}」(${Math.round(nearest.d)}km)`
      : `⚠ 坐标贴着「${nearest.name}」(${Math.round(nearest.d)}km)，但地址读不出城市 → 人工核`;
  } else if (stated) {
    // 地址支持当前城市，坐标又在几百公里外的本城辖域内 → 大市域远郊，正常
    kind = "ok";
    tag = `远郊（离最近城 ${nearest ? nearest.name : "-"} 还有 ${nearest ? Math.round(nearest.d) : "-"}km），地址支持当前城市 → 正常`;
  } else {
    // 地址读不出城市、又离所有城都远 → 跨市门店（品牌地 vs 门店地），产品判断
    kind = "cross";
    tag = `跨市（离最近城 ${nearest ? nearest.name : "-"} ${nearest ? Math.round(nearest.d) : "-"}km），地址读不出城市 → 待产品判断`;
  }
  badCoord.push({
    id: s.id, name: s.name, cur, dSelf: Math.round(dSelf), kind, tag,
    nearest: nearest ? `${nearest.name}（${Math.round(nearest.d)}km）` : "-",
    stated, addr: s.address,
  });
}
badCoord.sort((a, b) => b.dSelf - a.dSelf);

console.log("═".repeat(72));
console.log(`门店地理体检　启用门店 ${studios.length}　有坐标 ${withCoord}　地址能读出城市 ${addrReadable}`);
console.log(`可信城市参考点 ${refs.size} 座（样本 ≥${REF_MIN_SAMPLE} 且内聚 ≥${REF_COHESION * 100}%）`);
console.log("═".repeat(72));

console.log(`\n【① 地址写明别的城市 → 城市挂错，可自动修】${badAddr.length} 条`);
if (badAddr.length) {
  for (const b of badAddr) {
    console.log(`  #${b.id}\t${b.cur} → ${b.stated}\t${b.name}\t${(b.addr || "").replace(/\n/g, " ").slice(0, 44)}`);
  }
  console.log("  ➜ 跑 calibrateStudioCity() 即可（地址判据），随后记得清 district");
} else console.log("  ✔ 无");

console.log(`\n【② 离本城参考点 > ${SUSPECT_KM}km 的门店】（按处置方式分组）`);

const groups = [
  ["city", "城市挂错 · 可自动修", "calibrate 的坐标判据会改（下一轮 tick 或重启时生效）"],
  ["coord", "坐标与地址矛盾 · 需人工核", "⚠ 不要自动改：分不清是坐标错还是地址错，改错会把好店搬走"],
  ["cross", "跨市门店 · 待产品判断", "品牌注册地 vs 门店所在地，看要不要按门店地建城"],
  ["ok", "远郊 · 正常，无需处理", "地址与坐标都支持当前城市，只是离主城区远"],
];
for (const [kind, title, action] of groups) {
  const list = badCoord.filter((b) => b.kind === kind);
  console.log(`\n  ── ${title}：${list.length} 条`);
  if (!list.length) continue;
  for (const b of list) {
    console.log(`     #${b.id}\t${b.cur}\t离本城 ${b.dSelf}km\t${b.name}`);
    console.log(`           ${b.tag}`);
    if (b.addr) console.log(`           地址：${b.addr.replace(/\n/g, " ").slice(0, 58)}`);
  }
  console.log(`     ➜ ${action}`);
}

console.log(`\n【④ 坐标越界（不在中国范围内）】${outOfRange.length} 条`);
for (const b of outOfRange) console.log(`  #${b.id}\t${b.cur}\t${b.lat},${b.lng}\t${b.name}`);

if (weakRefs.length) {
  console.log(`\n【⚠ 参考点内聚度不足的城市（已排除出自动判定）】${weakRefs.length} 座`);
  for (const r of weakRefs) {
    console.log(`  ${r.name}\t样本 ${r.n}\t内聚 ${(r.cohesion * 100).toFixed(0)}%\t参考点 ${r.lat.toFixed(3)},${r.lng.toFixed(3)}`);
  }
}

const okTotal = badAddr.length + badCoord.length + outOfRange.length;
console.log(`\n${"═".repeat(72)}`);
console.log(okTotal ? `合计待处理 ${okTotal} 条` : "✔ 全部通过，没有发现地理归属矛盾");
console.log("═".repeat(72));
process.exit(0);
