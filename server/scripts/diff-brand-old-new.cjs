/** 改动前后品牌列表对比：确认只有「新增/合并」，没有把已有品牌弄丢 */
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

const NOISE_RE =
  /[（(][^）)]*(?:地图|导航|预约|指引|营业|电话|微信|扫码|关注|点击)[^）)]*[）)]\s*$/;
const TRAILING_PAREN_RE = /\s*[（(][^）)]*[）)]\s*$/;

function cleanName(name, max = 12) {
  if (!name) return "";
  let s = String(name).trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(NOISE_RE, "").replace(TRAILING_PAREN_RE, "").trim();
    if (s === before) break;
  }
  if (!s) s = String(name).trim();
  if (s.length > max) s = s.slice(0, max) + "…";
  return s;
}

/** 改前：「·」优先 + 无聚类 + 无归一 */
function oldBrand(name) {
  const raw = String(name || "").trim();
  const dot = raw.indexOf("·");
  if (dot > 0) return { brand: raw.slice(0, dot).trim(), branch: cleanName(raw.slice(dot + 1)) };
  const m = raw.match(/^(.*?)\s*[（(]\s*([^）)]+?)\s*[）)]\s*$/);
  if (m && m[1].trim() && m[2].trim() && !NOISE_RE.test(raw)) {
    return { brand: m[1].trim(), branch: cleanName(m[2]) };
  }
  return { brand: "", branch: "" };
}

const oldKey = (b) => String(b || "").replace(/\s+/g, "").toLowerCase();

(async () => {
  const studios = await p.studio.findMany({
    where: { status: true },
    select: { id: true, name: true, cityId: true },
  });
  const cities = await p.city.findMany({ select: { id: true, name: true } });
  const cn = new Map(cities.map((c) => [c.id, c.name]));

  const { splitBrandBranch, brandKey, clusterByPrefix, cleanBrandLabel } = await import(
    "../src/lib/studio-name.js"
  );

  const oldMap = new Map();
  for (const s of studios) {
    const { brand } = oldBrand(s.name);
    if (!brand) continue;
    const k = s.cityId + "|" + oldKey(brand);
    if (!oldMap.has(k)) oldMap.set(k, { city: cn.get(s.cityId), name: brand, ids: new Set() });
    oldMap.get(k).ids.add(s.id);
  }
  const oldBrands = [...oldMap.values()].filter((b) => b.ids.size >= 2);

  const byCity = new Map();
  for (const s of studios) {
    if (!byCity.has(s.cityId)) byCity.set(s.cityId, []);
    byCity.get(s.cityId).push(s);
  }
  const newBrands = [];
  for (const [cid, list] of byCity) {
    const map = new Map();
    const left = [];
    for (const s of list) {
      const { brand } = splitBrandBranch(s.name);
      if (brand) {
        const k = brandKey(brand);
        if (!map.has(k)) map.set(k, { label: brand, ids: new Set() });
        map.get(k).ids.add(s.id);
      } else left.push(s);
    }
    for (const [id, { brand }] of clusterByPrefix(left)) {
      const k = brandKey(brand);
      if (!map.has(k)) map.set(k, { label: brand, ids: new Set() });
      map.get(k).ids.add(id);
    }
    for (const g of map.values()) {
      if (g.ids.size >= 2) newBrands.push({ city: cn.get(cid), name: cleanBrandLabel(g.label), ids: g.ids });
    }
  }

  console.log("改前品牌:", oldBrands.length, "→ 改后:", newBrands.length);

  // 改前有、改后没了的（按城市+品牌名匹配）
  console.log("\n=== ⚠ 改后消失的品牌 ===");
  let lost = 0;
  for (const b of oldBrands) {
    const hit = newBrands.find((n) => n.city === b.city && oldKey(n.name) === oldKey(b.name));
    if (!hit) {
      console.log(`  [${b.city}] ${b.name} — 曾 ${b.ids.size} 家`);
      lost++;
    } else if (hit.ids.size < b.ids.size) {
      console.log(`  [${b.city}] ${b.name} — 门店数 ${b.ids.size} → ${hit.ids.size}（缩水）`);
      lost++;
    }
  }
  if (!lost) console.log("  （无）");

  console.log("\n=== 新增品牌 ===");
  const gained = newBrands.filter(
    (n) => !oldBrands.some((b) => b.city === n.city && oldKey(b.name) === oldKey(n.name))
  );
  gained
    .sort((a, b) => b.ids.size - a.ids.size)
    .forEach((b) => console.log(`  [${b.city}] ${b.name} — ${b.ids.size} 家`));

  await p.$disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
