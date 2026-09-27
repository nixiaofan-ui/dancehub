import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CENTERS_FILE = path.resolve(__dirname, "../data/city-centers.json");

/** 城市中心点（[lng, lat]，GCJ-02），用于「定位 → 城市」的兜底反查 */
let centersCache = null;
function cityCenters() {
  if (!centersCache) {
    try {
      centersCache = JSON.parse(fs.readFileSync(CENTERS_FILE, "utf8"));
    } catch {
      centersCache = {};
    }
  }
  return centersCache;
}

/** 球面距离（km） */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 逆地理编码（精确，但有外部依赖）。
 * 配了 TENCENT_MAP_KEY 才走；没配则退回下面的「最近城市」算法。
 * 失败一律抛错，由调用方兜底——定位不该让首屏挂掉。
 */
async function reverseGeocode(lat, lng, key) {
  const url =
    "https://apis.map.qq.com/ws/geocoder/v1/?location=" +
    lat +
    "," +
    lng +
    "&key=" +
    encodeURIComponent(key);
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  if (j.status !== 0) throw new Error(j.message || "逆地理失败");
  const city = j.result?.address_component?.city;
  // 直辖市返回的形如「上海市」，统一去掉行政后缀再匹配库里的名字
  return city ? String(city).replace(/(市|自治州|地区|特别行政区)$/, "") : null;
}

/**
 * POST /api/cities/locate —— 把客户端给的经纬度解析成库里的城市。
 *
 * 为什么放在服务端：城市中心点表和「哪些城市真有课」都在库里，
 * 客户端拿不到；而且以后换成腾讯逆地理只需要改这里，不用发新版小程序。
 *
 * 两级策略：
 *   1) 配了 TENCENT_MAP_KEY → 逆地理拿准确城市名（精度高，需申请 key）
 *   2) 否则 → 在「有课的城市」里找最近的中心点（无需任何外部依赖）
 *
 * @body { lat: number, lng: number }
 * @returns { matched, cityId, name, distanceKm, method } | { matched: false, nearest }
 */
router.post(
  "/locate",
  asyncHandler(async (req, res) => {
    const lat = Number(req.body && req.body.lat);
    const lng = Number(req.body && req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return fail(res, 400, "坐标缺失或非法");
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return fail(res, 400, "坐标超出范围");
    }

    const cities = await prisma.city.findMany({
      where: { region: "CN" },
      include: { _count: { select: { studios: { where: { status: true } } } } },
    });
    const withStudios = cities.filter((c) => c._count.studios > 0);
    const pool = withStudios.length ? withStudios : cities;
    if (!pool.length) return ok(res, { matched: false, reason: "no-city" });

    // 1) 逆地理优先
    let geoName = null;
    if (process.env.TENCENT_MAP_KEY) {
      try {
        geoName = await reverseGeocode(lat, lng, process.env.TENCENT_MAP_KEY);
      } catch (e) {
        console.warn("[locate] 逆地理失败，退回最近城市:", e.message);
      }
    }
    if (geoName) {
      const hit =
        pool.find((c) => c.name === geoName) ||
        pool.find((c) => geoName.indexOf(c.name) === 0 || c.name.indexOf(geoName) === 0);
      if (hit) {
        return ok(res, {
          matched: true,
          cityId: hit.id,
          name: hit.name,
          region: hit.region,
          method: "geocode",
        });
      }
    }

    // 2) 最近城市
    const centers = cityCenters();
    const scored = [];
    for (const c of pool) {
      const p = centers[c.name];
      if (!p) continue;
      scored.push({ c, km: distanceKm(lat, lng, p[1], p[0]) });
    }
    if (!scored.length) return ok(res, { matched: false, reason: "no-center" });
    scored.sort((a, b) => a.km - b.km);
    const best = scored[0];
    // 离最近的有课城市都超过 400km，说明用户所在地大概率还没接入
    const MAX_KM = 400;
    return ok(res, {
      matched: best.km <= MAX_KM,
      cityId: best.c.id,
      name: best.c.name,
      region: best.c.region,
      distanceKm: Math.round(best.km * 10) / 10,
      method: "nearest",
      nearest: scored.slice(0, 3).map((s) => ({ name: s.c.name, km: Math.round(s.km * 10) / 10 })),
    });
  }),
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { region } = req.query;
    const where = region ? { region } : {};
    // 带上每个城市的可见门店数（发现页城市切换器显示用）
    const cities = await prisma.city.findMany({
      where,
      orderBy: { id: "asc" },
      include: { _count: { select: { studios: { where: { status: true } } } } },
    });
    ok(
      res,
      cities
        .map((c) => ({
          id: c.id,
          region: c.region,
          name: c.name,
          studioCount: c._count.studios,
        }))
        .filter((c) => c.studioCount > 0)
        // 横滑 chip 条上百来个城市，按门店数排，热门城市才不会被埋在最后
        .sort((a, b) => b.studioCount - a.studioCount),
    );
  }),
);

export default router;