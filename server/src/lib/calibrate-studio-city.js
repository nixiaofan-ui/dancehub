/**
 * 门店城市校正（幂等，可重复执行）。
 *
 * 场景：库里的店挂在错误城市下。三类成因（都实测过）：
 *   ① 配置生成器判断城市**优先用坐标框**，而坐标框是方的 —— 广州的框
 *      (22.4,23.7,112.8,114.1) 把佛山**和深圳**整个包住，且遍历时广州排在深圳前面，
 *      于是深圳的店先被广州吃掉（2026-10-16 实测 10 家：八卦岭/车公庙/坂田/南山…）。
 *   ② 爱舞功用**品牌注册地**的行政区划码当城市（「爱舞功开发版」注册在北京、
 *      门店在广州）。
 *   ③ 生成器的**城市关键词兜底**把路名/地标当城市线索：「北京路」（昆明、社旗）、
 *      「上海路」（十堰）、「青岛路」（金昌）、「福田一百商业广场」（诸暨）、
 *      「国贸大厦」（恩施）→ 昆明的店标北京、十堰的店标上海（2026-10-16 实测 8 家）。
 * 后果：用户在广州列表里翻到深圳的店（距离排在最后），按「深圳」却搜不到；而且
 * 区名是从地址按城市名抽取的（fill-district 的候选表按城市限定），城市错了区名必然跟着错。
 *
 * 三档判据，**从严到宽**逐档尝试，前档命中就不进后档：
 *   ① `city-overrides.json`（人工核定，按 id）—— 给「地址读不出城市、只能靠坐标定性」的店。
 *      为什么需要人工表：② 的判据是「地址写明城市才改」，而这类店的地址**只有路名**，
 *      读不出城市；宁可不改也不猜是原则，但代价是它们永远修不了。人工核定过、有坐标
 *      交叉验证（OSM 逆地理）的店走这里。
 *   ② 地址里**明确写了城市名**才改 —— 地址是商家自己填的真地址，写着「佛山市禅城区」，
 *      比坐标框和注册地都权威。读不出城市（如「麦子店街53号」）就原样不动。
 *   ③ 地址读不出城市时，用**坐标对库内城市参考点**判定：坐标离本城参考点 >80km、
 *      离另一座城的参考点 <25km → 它其实属于那座城。参考点 = 该城有坐标门店的
 *      **中位数坐标**（抗离群），且要求样本 ≥3 家、内聚度 ≥70%（防参考点被错店污染）。
 *      ⛔ 这条**只改「已经离得很远」的店**：远郊区县（重庆万州离主城 222km）离任何
 *      其他城参考点都 >100km → 不动；跨城通勤带（昆山店离苏州 40km）本城距离没超 80km
 *      → 也不进这条。两个条件同时成立才动手。
 *
 * ⚠ 只改 cityId，**不改店名**（与 calibrate-gsteps-city 的区别）：G-STEPS 的店名里带
 *   城市后缀（「G-STEPS·上海新天地店（北京）」），不改名下一轮就建新店；这批店名里
 *   不含城市后缀，只改 cityId 是安全的。若将来出现「店名带城市」的店，要连名字一起改
 *   （配置里的 legacyNames + renameStudios 那套）。
 * ⚠ 改城市必须**一并清掉 district**：区名候选表按城市限定（district-names.json 是
 *   `{城市:[区名]}`），不清就是「绍兴的店挂着深圳的福田区」；fill-district 只填 null，
 *   清了才会按新城市重抽。
 *
 * ⚠ 不设「进程内只跑一次」：新抓进来的店可能又带错城市，所以每轮 tick 都扫一遍
 *   （6 小时节流，只读一次 findMany，成本可忽略）。启动时强制跑一次，且**必须排在
 *   ensureDistrict 之前** —— 区名候选表按城市限定，先校正城市才能抽对区。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./prisma.js";
import { cityFromAddress } from "./city-names.js";
import { invalidateStudioIndex } from "./studio-index.js";

/** 与抓取刷新节奏一致的节流窗口（6 小时） */
const CALIBRATE_MS = 6 * 3600_000;
let lastRunAt = 0;

/** 离本城参考点超过这个距离 → 城市可疑，进入坐标判据 */
const FAR_FROM_CITY_KM = 80;
/** 离目标城参考点在这个距离内 → 认定它其实属于那座城 */
const NEAR_OTHER_CITY_KM = 25;
/** 参考点至少要有这么多家有坐标门店才可信（1-2 家时中位数=那家店本身，等于没参考） */
const REF_MIN_SAMPLE = 3;
/** 参考点内聚度下限：至少这个比例的店要落在参考点 80km 内，否则判该城参考点被污染 */
const REF_COHESION = 0.7;

const CRAWLER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../crawler",
);

/**
 * 人工表的键 = **坐标优先**，没坐标才退回 id。
 *
 * ⛔ 不能只按 studioId：本地库和云库的 id **不对齐**（实测本地 #2075 的
 * 「赤热舞蹈阳光栖谷校区」在云上是 #2031），按 id 索引的表换一个库就整张失效 ——
 * 而这张表存在的意义恰恰是「两个库都要能修」。坐标是上游给的真实值、两库一致。
 */
function overrideKeyFor(s) {
  if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
    return `geo:${s.lat.toFixed(4)},${s.lng.toFixed(4)}`; // 4 位小数≈11m，足够唯一
  }
  return `id:${s.id}`;
}

/**
 * 命中人工表。坐标键为主、id 键兼容；表里给了 `names` 还要店名对得上 ——
 * 防止坐标巧合撞上另一家店（也防止门店改名后被硬改到别处）→ 撞上就**不硬改**，留给人工看。
 */
function matchOverride(overrides, s) {
  const hit = overrides.get(overrideKeyFor(s)) || overrides.get(`id:${s.id}`);
  if (!hit) return null;
  const names = hit.names;
  if (Array.isArray(names) && names.length && !names.includes(s.name)) return null;
  return hit;
}

/** 人工核定修正表；读不到/格式坏时退化为空表（不能让校准整体挂掉） */
function loadCityOverrides() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(CRAWLER_DIR, "city-overrides.json"), "utf8"),
    );
    const out = new Map();
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_") || !v || !v.city) continue;
      out.set(String(k), v);
    }
    return out;
  } catch (e) {
    console.warn(`[city] city-overrides.json 读取失败：${e.message}`);
    return new Map();
  }
}

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

/** 有坐标的 CN 门店 → 每座城的参考点（中位数 + 内聚度校验） */
function buildCityRefs(rows, regionById) {
  const by = new Map();
  for (const s of rows) {
    if (regionById.get(s.cityId) !== "CN") continue;
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    if (!by.has(s.cityId)) by.set(s.cityId, []);
    by.get(s.cityId).push(s);
  }
  const refs = new Map();
  for (const [cid, arr] of by) {
    if (arr.length < REF_MIN_SAMPLE) continue;
    const ref = { lat: median(arr.map((s) => s.lat)), lng: median(arr.map((s) => s.lng)), n: arr.length };
    const near = arr.filter((s) => haversine(s, ref) <= FAR_FROM_CITY_KM).length;
    ref.cohesion = near / arr.length;
    if (ref.cohesion < REF_COHESION) continue; // 参考点被错店污染 → 这座城市退出判定
    refs.set(cid, ref);
  }
  return refs;
}

/**
 * 扫全库校正城市归属。
 *
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ checked: number, changed: number, skipped: number, createdCities: string[], byOverride: number, byCoord: number }>}
 */
export async function calibrateStudioCity(opts = {}) {
  const log = opts.log || (() => {});

  const studios = await prisma.studio.findMany({
    where: { status: true },
    select: { id: true, name: true, cityId: true, address: true, district: true, lat: true, lng: true },
  });
  if (!studios.length) {
    return { checked: 0, changed: 0, skipped: 0, createdCities: [], byOverride: 0, byCoord: 0 };
  }

  const cities = await prisma.city.findMany({
    select: { id: true, name: true, region: true },
  });
  /** "CN|佛山" → cityId */
  const idByKey = new Map(cities.map((c) => [`${c.region}|${c.name}`, c.id]));
  const nameById = new Map(cities.map((c) => [c.id, c.name]));
  const regionById = new Map(cities.map((c) => [c.id, c.region]));

  let changed = 0;
  let skipped = 0;
  let byOverride = 0;
  let byCoord = 0;
  const createdCities = [];

  /** 改一家店的城市（顺带清 district，让 fill-district 按新城市重抽）。幂等：目标已是该城则跳过。 */
  async function moveTo(s, want, why) {
    const cur = nameById.get(s.cityId);
    if (!want || cur === want) return false;

    let targetId = idByKey.get(`CN|${want}`);
    if (!targetId) {
      const created = await prisma.city.create({
        data: { region: "CN", name: want },
        select: { id: true },
      });
      targetId = created.id;
      idByKey.set(`CN|${want}`, targetId);
      nameById.set(targetId, want);
      regionById.set(targetId, "CN");
      if (!createdCities.includes(want)) createdCities.push(want);
      log(`[city] 新建城市「${want}」`);
    }

    await prisma.studio.update({
      where: { id: s.id },
      data: { cityId: targetId, district: null },
    });
    // 就地更新内存态：后面的参考点计算要用「已经校正过」的城市
    s.cityId = targetId;
    changed += 1;
    log(`[city] #${s.id}「${s.name}」${cur} → ${want}（${why}）`);
    return true;
  }

  // ─── ① 人工核定表（坐标交叉验证过的那批，地址读不出城市的） ───────────
  const overrides = loadCityOverrides();
  if (overrides.size) {
    for (const s of studios) {
      if (regionById.get(s.cityId) !== "CN") continue;
      const ov = matchOverride(overrides, s);
      if (!ov) continue;
      if (await moveTo(s, ov.city, `人工核定：${ov.why}`)) byOverride += 1;
    }
  }

  // ─── ② 地址判据：地址里写明别的城市 ────────────────────────────────
  for (const s of studios) {
    // 海外店（首尔/东京/大阪）的地址抽不出中国城市名，天然被这条挡掉
    if (regionById.get(s.cityId) !== "CN") continue;

    const want = cityFromAddress(s.address);
    if (!want) {
      skipped += 1;
      continue;
    }
    await moveTo(s, want, `地址：${s.address}`);
  }

  // ─── ③ 坐标判据：地址读不出城市，但坐标明显属于另一座城 ──────────────
  // 参考点在 ② 之后重算 —— 已经搬对城的店会一起参与，参考点更干净。
  const refs = buildCityRefs(studios, regionById);
  if (refs.size) {
    for (const s of studios) {
      if (regionById.get(s.cityId) !== "CN") continue;
      if (cityFromAddress(s.address)) continue; // ② 已判过（含「已是该城」的稳态）
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;

      const self = refs.get(s.cityId);
      if (!self) continue; // 本城参考点不可信（样本不足/被污染）→ 宁可不改
      const dSelf = haversine(s, self);
      if (dSelf <= FAR_FROM_CITY_KM) continue; // 就在本城范围内（含远郊）→ 不动

      let best = null;
      for (const [cid, ref] of refs) {
        if (cid === s.cityId) continue;
        const d = haversine(s, ref);
        if (d <= NEAR_OTHER_CITY_KM && (!best || d < best.d)) best = { cid, d };
      }
      if (!best) continue; // 离谁都远（真远郊/跨省无覆盖）→ 不动

      const want = nameById.get(best.cid);
      const why =
        `坐标距本城参考点 ${Math.round(dSelf)}km、距「${want}」参考点 ${Math.round(best.d)}km`;
      if (await moveTo(s, want, why)) byCoord += 1;
    }
  }

  if (changed) {
    // 搜索索引按城市缓存（TTL 10min）：不失效的话，用户这几分钟里按新城市
    // 筛仍然是 0 条，按旧城市反而还能搜到
    invalidateStudioIndex();
    log(
      `[city] 门店城市校正：改了 ${changed} 家（人工核定 ${byOverride} / 坐标判据 ${byCoord}）`,
    );
  }
  return {
    checked: studios.length,
    changed,
    skipped,
    createdCities,
    byOverride,
    byCoord,
  };
}

/**
 * tick 里的节流包装。启动流程直接调 calibrateStudioCity 走全量，不走这里。
 *
 * @param {string} [reason]
 * @param {{ force?: boolean }} [opts]
 */
export async function maybeCalibrateStudioCity(reason = "tick", opts = {}) {
  const now = Date.now();
  if (!opts.force && now - lastRunAt < CALIBRATE_MS) return null;
  lastRunAt = now;
  try {
    const r = await calibrateStudioCity({ log: (m) => console.log(m) });
    if (r.changed) console.log(`[crawler] ${reason}：门店城市校正 ${r.changed} 家`);
    return r;
  } catch (e) {
    console.error(`[crawler] 门店城市校正失败: ${e.message}`);
    return null;
  }
}
