/**
 * 门店地理位置体检（**只读**）。给人和给机器各一个出口：
 *   · `tools/audit-studio-location.mjs` 打成一张可读的表（本地排查用）
 *   · `GET /api/crawler/audit-location` 回结构化 JSON（**排查线上用** ——
 *     云库不开公网、本地库又和云库不同步，没有这个出口就只能靠猜「云端修没修」）
 *
 * 为什么要分四类报：成因不同**修法完全不同**，混在一起会把人带偏。
 *   ① 城市挂错，且地址写明城市   → calibrate 的地址判据自动修
 *   ② 城市挂错，地址读不出城市   → calibrate 的坐标判据能修大部分；
 *      目标城太小没参考点的要进 city-overrides.json（人工核定）
 *   ③ 坐标与地址矛盾（城市对、坐标在别处）→ ⛔ **不能自动改**：分不清是坐标错
 *      还是地址错，改错就是「把一家好店搬到更错的城市」。必须人工核。
 *   ④ 远郊 / 跨市                → 不是错误，只是离得远，别去动它
 *
 * 判定用「城市参考点」= 该城有坐标门店的**中位数坐标**（抗离群：广州 52 家里
 * 混 11 家深圳店，参考点依然稳在广州）。样本 <3 家或内聚度 <70% 的城退出判定。
 */
import { prisma } from "./prisma.js";
import { cityFromAddress } from "./city-names.js";

/** 离本城参考点超过这个距离 → 值得看一眼 */
export const SUSPECT_KM = 80;
/** 离另一座城的参考点在这个距离内 → 基本可断定它属于那座城 */
export const OTHER_CITY_KM = 25;
/** 离另一座城参考点在这个距离内 → 坐标「贴着」那座城，与自己城市的归属至少有一处错 */
export const NEAR_CITY_KM = 80;
/** 参考点样本下限与内聚度下限（⛔ 必须与 calibrate-studio-city.js 一致，口径不能分叉） */
const REF_MIN_SAMPLE = 3;
const REF_COHESION = 0.7;
/** 中国大致范围（同 fill-latlng.js） */
const LAT_RANGE = [3, 54];
const LNG_RANGE = [73, 136];

export function haversine(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * 扫全库，把地理归属可疑的门店分类报出来。
 *
 * @param {{ log?: (m: string) => void }} [opts]
 * @returns {Promise<{
 *   total: number, withCoord: number, addrReadable: number, refCities: number,
 *   addrMismatch: Array<any>, outOfRange: Array<any>,
 *   byKind: { city: Array<any>, coord: Array<any>, cross: Array<any>, ok: Array<any> },
 *   weakRefs: Array<any>,
 * }>}
 */
export async function auditStudioLocation(opts = {}) {
  const log = opts.log || (() => {});

  const studios = await prisma.studio.findMany({
    where: { status: true },
    select: { id: true, name: true, cityId: true, address: true, district: true, lat: true, lng: true },
  });
  const cities = await prisma.city.findMany({ select: { id: true, name: true, region: true } });
  const cname = new Map(cities.map((c) => [c.id, c.name]));
  const cregion = new Map(cities.map((c) => [c.id, c.region]));

  // 每座城的参考点（中位数 + 内聚度）
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
    if (ref.cohesion < REF_COHESION) {
      weakRefs.push({ city: cname.get(cid), n: ref.n, cohesion: Number(ref.cohesion.toFixed(2)) });
    } else {
      refs.set(cid, ref);
    }
  }

  const addrMismatch = [];
  const outOfRange = [];
  const byKind = { city: [], coord: [], cross: [], ok: [] };
  let withCoord = 0;
  let addrReadable = 0;

  for (const s of studios) {
    if (cregion.get(s.cityId) !== "CN") continue;
    const cur = cname.get(s.cityId);
    const stated = cityFromAddress(s.address);
    if (stated) addrReadable += 1;
    if (stated && stated !== cur) {
      addrMismatch.push({
        id: s.id, name: s.name, city: cur, shouldBe: stated,
        district: s.district, address: s.address,
      });
    }
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    withCoord += 1;
    if (
      s.lat < LAT_RANGE[0] || s.lat > LAT_RANGE[1] ||
      s.lng < LNG_RANGE[0] || s.lng > LNG_RANGE[1]
    ) {
      outOfRange.push({ id: s.id, name: s.name, city: cur, lat: s.lat, lng: s.lng });
      continue;
    }

    const self = refs.get(s.cityId);
    if (!self) continue; // 本城参考点不可信 → 这座城不参与判定
    const dSelf = haversine(s, self);
    if (dSelf <= SUSPECT_KM) continue;

    let nearest = null;
    for (const [cid, ref] of refs) {
      if (cid === s.cityId) continue;
      const d = haversine(s, ref);
      if (!nearest || d < nearest.d) nearest = { city: cname.get(cid), d };
    }

    const base = {
      id: s.id, name: s.name, city: cur, kmFromOwnCity: Math.round(dSelf),
      nearestOtherCity: nearest ? nearest.city : null,
      kmToNearestOtherCity: nearest ? Math.round(nearest.d) : null,
      address: s.address,
    };

    if (nearest && nearest.d <= OTHER_CITY_KM && !stated) {
      // 离另一座城极近、地址又读不出城市 → 它其实属于那座城（calibrate 可自动修）
      byKind.city.push(base);
    } else if (nearest && nearest.d <= NEAR_CITY_KM) {
      // 坐标紧贴另一座城 → 坐标与归属至少有一处错，**必须人工核**
      byKind.coord.push(base);
    } else if (stated) {
      // 地址支持当前城市，坐标也在本城辖域内 → 大市域远郊，正常
      byKind.ok.push(base);
    } else {
      // 地址读不出城市、离所有城都远 → 跨市门店（品牌地 vs 门店地），产品判断
      byKind.cross.push(base);
    }
  }

  for (const k of Object.keys(byKind)) {
    byKind[k].sort((a, b) => b.kmFromOwnCity - a.kmFromOwnCity);
  }

  log(
    `[geo-audit] ${studios.length} 家启用门店：地址城市不符 ${addrMismatch.length}，` +
      `离本城 >${SUSPECT_KM}km ${byKind.city.length + byKind.coord.length + byKind.cross.length + byKind.ok.length}` +
      `（可自动修 ${byKind.city.length} / 需人工 ${byKind.coord.length} / 跨市 ${byKind.cross.length} / 远郊正常 ${byKind.ok.length}），` +
      `坐标越界 ${outOfRange.length}`,
  );

  return {
    total: studios.length,
    withCoord,
    addrReadable,
    refCities: refs.size,
    addrMismatch,
    outOfRange,
    byKind,
    weakRefs,
  };
}
