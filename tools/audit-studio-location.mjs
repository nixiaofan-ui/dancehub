/**
 * 门店地理体检（命令行出口，**只读**）。
 *
 * 判据、分类规则都在 `server/src/lib/audit-studio-location.js` —— 同一份实现也挂了
 * 一个只读 HTTP 端点（`GET /api/crawler/audit-location`），用来体检**线上云库**
 * （云库不开公网、本地库又和云库不同步，没有那个出口就只能靠猜）。
 *
 * 跑法：
 *   cd server && /usr/local/bin/node ../tools/audit-studio-location.mjs
 *
 * 报告按**处置方式**分四组，不按异常程度排序 —— 因为这四类的修法完全不同：
 *   城市挂错·可自动修 / 坐标与地址矛盾·需人工核 / 跨市·待产品判断 / 远郊·正常
 */
import {
  auditStudioLocation,
  SUSPECT_KM,
  OTHER_CITY_KM,
  NEAR_CITY_KM,
} from "../server/src/lib/audit-studio-location.js";

const r = await auditStudioLocation({});

console.log("═".repeat(74));
console.log(
  `门店地理体检　启用门店 ${r.total}　有坐标 ${r.withCoord}　地址能读出城市 ${r.addrReadable}`,
);
console.log(
  `可信城市参考点 ${r.refCities} 座　越界坐标 ${r.outOfRange.length} 条　` +
    `地址城市不符 ${r.addrMismatch.length} 条`,
);
console.log("═".repeat(74));

console.log(`\n【① 地址写明别的城市 → 城市挂错，可自动修】${r.addrMismatch.length} 条`);
if (r.addrMismatch.length) {
  for (const b of r.addrMismatch) {
    console.log(`  #${b.id}\t${b.city} → ${b.shouldBe}\t${b.name}\t${(b.address || "").replace(/\n/g, " ").slice(0, 42)}`);
  }
  console.log("  ➜ 跑 calibrateStudioCity() 即可（地址判据），改完会自动清 district");
} else {
  console.log("  ✔ 无");
}

console.log(`\n【② / ③ / ④ 离本城参考点 > ${SUSPECT_KM}km 的门店】（按处置方式分组）`);
const groups = [
  ["city", "城市挂错 · 可自动修", `calibrate 的坐标判据会改（离另一城 <${OTHER_CITY_KM}km）`],
  ["coord", "坐标与地址矛盾 · 需人工核", `⚠ 不要自动改：坐标贴着别的城（<${NEAR_CITY_KM}km），分不清是坐标错还是地址错`],
  ["cross", "跨市门店 · 待产品判断", "品牌注册地 vs 门店所在地，看要不要按门店地建城"],
  ["ok", "远郊 · 正常，无需处理", "地址与坐标都支持当前城市，只是离主城区远"],
];
for (const [kind, title, action] of groups) {
  const list = r.byKind[kind] || [];
  console.log(`\n  ── ${title}：${list.length} 条`);
  for (const b of list) {
    console.log(
      `     #${b.id}\t${b.city}\t离本城 ${b.kmFromOwnCity}km\t` +
        `最近他城 ${b.nearestOtherCity || "-"} ${b.kmToNearestOtherCity ?? "-"}km\t${b.name}`,
    );
    if (b.address) console.log(`           地址：${b.address.replace(/\n/g, " ").slice(0, 58)}`);
  }
  if (list.length) console.log(`     ➜ ${action}`);
}

console.log(`\n【④ 坐标越界（不在中国范围内）】${r.outOfRange.length} 条`);
for (const b of r.outOfRange) console.log(`  #${b.id}\t${b.city}\t${b.lat},${b.lng}\t${b.name}`);

if (r.weakRefs.length) {
  console.log(`\n【⚠ 参考点内聚度不足的城市（已排除出自动判定）】${r.weakRefs.length} 座`);
  for (const w of r.weakRefs) {
    console.log(`  ${w.city}\t样本 ${w.n}\t内聚 ${(w.cohesion * 100).toFixed(0)}%`);
  }
}

const todo = r.addrMismatch.length + r.byKind.city.length + r.byKind.coord.length + r.outOfRange.length;
console.log(`\n${"═".repeat(74)}`);
console.log(
  todo
    ? `合计待处理 ${todo} 条（另：跨市 ${r.byKind.cross.length} / 远郊正常 ${r.byKind.ok.length}）`
    : "✔ 没有发现地理归属矛盾",
);
console.log("═".repeat(74));
process.exit(0);
