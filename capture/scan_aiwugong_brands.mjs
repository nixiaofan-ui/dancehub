#!/usr/bin/env node
/**
 * 爱舞功 / 舞十（wushi.api.aiwugong.cn）平台舞室扫描 + 配置生成
 * ------------------------------------------------------------------
 * 这是继 iWOD、菲体云之后的第三套舞蹈 SaaS 平台，接入要点：
 *
 *   1) 品牌枚举（免登录）POST /Applets/login/brand.html
 *        body: host=<任意小程序 appId>&brand_id=<1..N>
 *        → bug.{id, brand_name, slogan, address, city, synopsis,
 *               notlogin_isshowcourse, status}
 *      brand_id 是小整数自增，逐个试即可拿到全平台品牌清单。
 *
 *   2) 课表（免登录）POST /Applets/course/index-not-login.html
 *        body: host=&brand_id=&date=YYYY-MM-DD&page=N
 *        → bug.data[] = [{ store_id, store:"门店名", course:[...] }]
 *      ⚠ 只给 host 不给 brand_id 会 500（SQL ORDER BY FIELD() 参数为空）。
 *
 *   3) notlogin_isshowcourse=1 的品牌未登录才看得到课表，=0 的抓不到课。
 *
 * 用法：
 *   node capture/scan_aiwugong_brands.mjs                 # 扫 1..700 全平台
 *   node capture/scan_aiwugong_brands.mjs --max 300
 *   node capture/scan_aiwugong_brands.mjs --cities 深圳,广州
 *   node capture/scan_aiwugong_brands.mjs --from-cache /tmp/brands-wushi.json
 *   node capture/scan_aiwugong_brands.mjs --out server/src/crawler/studios.aiwugong.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const MAX_ID = Number(arg("max", 700));
const HOST = arg("host", "wx4d02b14543b4b8b8"); // CLAP dance studio 的 appId，仅作 host 占位
const BASE = arg("base", "https://wushi.api.aiwugong.cn");
const CACHE = arg("from-cache", "");
const CITY_FILTER = arg("cities", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = path.resolve(ROOT, arg("out", "server/src/crawler/studios.aiwugong.json"));

/** 行政区划码 → 城市名（平台 city 字段是 "440000,440300" 这种逗号串） */
const CITY_NAME = {
  "440300": "深圳",
  "440100": "广州",
  "441900": "东莞",
  "442000": "中山",
  "310100": "上海",
  "110100": "北京",
  "330100": "杭州",
  "320100": "南京",
  "320500": "苏州",
  "510100": "成都",
  "500100": "重庆",
  "430100": "长沙",
  "410100": "郑州",
  "420100": "武汉",
  "610100": "西安",
  "370100": "济南",
  "370200": "青岛",
  "350200": "厦门",
  "350100": "福州",
  "210100": "沈阳",
  "220100": "长春",
  "230100": "哈尔滨",
  "130100": "石家庄",
  "340100": "合肥",
  "360100": "南昌",
  "530100": "昆明",
  "520100": "贵阳",
  "620100": "兰州",
  "460100": "海口",
  "450100": "南宁",
  "630100": "西宁",
  "640100": "银川",
  "650100": "乌鲁木齐",
  "120100": "天津",
  "140100": "太原",
};

function cityOf(rawCity) {
  const codes = String(rawCity || "").split(",").filter(Boolean);
  // 取最后一段（市级码）优先，回落逐段找
  for (let i = codes.length - 1; i >= 0; i--) {
    if (CITY_NAME[codes[i]]) return CITY_NAME[codes[i]];
  }
  return codes.length ? codes[codes.length - 1] : "未知";
}

async function post(url, body) {
  const r = await fetch(BASE + url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15000),
  });
  return await r.text();
}

async function fetchBrand(id) {
  try {
    const t = await post("/Applets/login/brand.html", { host: HOST, brand_id: String(id) });
    if (t.includes("toArray() on null")) return null;
    const b = JSON.parse(t).bug;
    if (!b || !b.id) return null;
    return {
      id: b.id,
      name: (b.brand_name || "").trim(),
      slogan: (b.slogan || "").trim(),
      address: (b.address || "").trim(),
      city: b.city,
      cityName: cityOf(b.city),
      synopsis: (b.synopsis || "").trim(),
      show: Number(b.notlogin_isshowcourse) === 1,
      status: b.status,
    };
  } catch {
    return null;
  }
}

/** 用当天课表接口反查门店清单（顺带验证该品牌课表是否真的可抓） */
async function fetchStores(brandId, date) {
  try {
    const t = await post("/Applets/course/index-not-login.html", {
      host: HOST,
      brand_id: String(brandId),
      date,
      page: "1",
    });
    const j = JSON.parse(t);
    if (j.code !== 0 || !j.bug) return { ok: false, stores: [], total: 0 };
    const stores = (j.bug.data || []).map((s) => ({
      id: String(s.store_id),
      name: String(s.store || "").trim(),
      count: (s.course || []).length,
    }));
    return { ok: true, stores, total: Number(j.bug.all) || 0 };
  } catch {
    return { ok: false, stores: [], total: 0 };
  }
}

/**
 * 门店表全量扫描（/Applets/store/view.html 免登录，按 id 自增）。
 * 门店本身带 brand_id，可反推「品牌 → 门店清单」，比只看当天课表更完整
 * （有的门店今天没排课，只在课表接口里会漏掉）。
 * 结果缓存在 /tmp/stores-aiwugong.json，重复运行不必重扫。
 */
async function scanStores() {
  const CACHE_FILE = "/tmp/stores-aiwugong.json";
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(cached) && cached.length > 100) {
        console.log(`门店表读缓存（${cached.length} 家）: ${CACHE_FILE}`);
        return cached;
      }
    } catch { /* 缓存坏了就重扫 */ }
  }
  console.log("扫描门店表 1..900（免登录）...");
  const all = [];
  for (let s = 1; s <= 900; s += 30) {
    const ids = [];
    for (let i = s; i < s + 30 && i <= 900; i++) ids.push(i);
    const batch = await Promise.all(
      ids.map(async (id) => {
        try {
          const t = await post("/Applets/store/view.html", { host: HOST, id: String(id) });
          if (t.includes("Forbidden")) return null;
          const d = JSON.parse(t).bug?.date || JSON.parse(t).bug?.data;
          return d && d.brand_id
            ? { id: String(d.id), brandId: Number(d.brand_id), name: String(d.name || "").trim(), address: d.address || null }
            : null;
        } catch { return null; }
      }),
    );
    all.push(...batch.filter(Boolean));
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(all, null, 1));
  console.log(`门店表扫描完成：${all.length} 家 → ${CACHE_FILE}`);
  return all;
}

const slug = (s) =>
  String(s)
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "studio";

(async () => {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

  let brands = [];
  if (CACHE && fs.existsSync(CACHE)) {
    console.log(`从缓存读取品牌清单: ${CACHE}`);
    brands = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } else {
    console.log(`扫描品牌 brand_id 1..${MAX_ID}（免登录接口）...`);
    for (let s = 1; s <= MAX_ID; s += 30) {
      const ids = [];
      for (let i = s; i < Math.min(s + 30, MAX_ID + 1); i++) ids.push(i);
      const batch = (await Promise.all(ids.map(fetchBrand))).filter(Boolean);
      brands.push(...batch);
      if (s % 150 === 1) console.log(`  ...到 ${s}，累计 ${brands.length} 个品牌`);
    }
    fs.writeFileSync("/tmp/brands-aiwugong.json", JSON.stringify(brands, null, 1));
    console.log(`品牌清单已存 /tmp/brands-aiwugong.json`);
  }

  if (CITY_FILTER.length) {
    brands = brands.filter((b) => CITY_FILTER.includes(b.cityName));
    console.log(`按城市过滤 ${CITY_FILTER.join("/")} → ${brands.length} 个品牌`);
  }

  console.log(`\n逐个品牌确认课表可抓性（${brands.length} 个，日期 ${today}）...`);
  const storeRows = await scanStores();
  const storesByBrand = new Map();
  for (const s of storeRows) {
    if (!storesByBrand.has(s.brandId)) storesByBrand.set(s.brandId, []);
    storesByBrand.get(s.brandId).push(s);
  }

  const configs = [];
  for (const b of brands) {
    const { ok, stores, total } = await fetchStores(b.id, today);
    // 门店清单：门店表（按 brand_id，最完整）∪ 当天课表里出现的门店
    const seen = new Map();
    for (const s of storesByBrand.get(b.id) || []) {
      seen.set(s.id, { id: s.id, name: s.name.split("|").pop().trim() || s.name, address: s.address || null });
    }
    for (const s of stores) {
      const id = s.id;
      const name = s.name.split("|").pop().trim() || s.name;
      if (seen.has(id)) continue;
      seen.set(id, { id, name, address: null });
    }
    const branches = [...seen.values()];
    configs.push({
      id: `aiwugong-${b.id}-${slug(b.name)}`,
      // 可抓性以「课表接口真的返回了数据」为准（品牌关掉未登录课表开关时接口仍可用）
      enabled: Boolean(ok && branches.length > 0),
      label: b.name,
      auto: true,
      studio: {
        name: b.name,
        city: b.cityName,
        region: "CN",
        // StudioPlatform 枚举只有 WECHAT/NAVER/INSTAGRAM/YOUTUBE/OTHER；
        // 爱舞功是微信小程序 SaaS，跳转预约也走小程序 → WECHAT
        platform: "WECHAT",
        officialUrl: null,
      },
      mode: "aiwugong",
      aiwugong: {
        baseUrl: BASE.replace(/\/$/, ""),
        host: HOST,
        brandId: b.id,
        branches,
      },
      dateMode: "nextDays",
      days: 7,
      dates: [],
      refreshHours: 6,
      cron: null,
      timeFormat: "HH:mm-HH:mm",
      address: b.address || null,
      _meta: {
        platformName: "AIWUGONG",
        slogan: b.slogan || null,
        synopsis: b.synopsis || null,
        notloginShowCourse: b.show,
        todayCourses: total,
        verifiedAt: today,
      },
    });
    if (configs.length % 20 === 0) console.log(`  ...已处理 ${configs.length}/${brands.length}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(configs, null, 2) + "\n");

  const on = configs.filter((c) => c.enabled);
  console.log(`\n写入 ${path.relative(ROOT, OUT)}`);
  console.log(`  品牌总数      ${configs.length}`);
  console.log(`  已启用        ${on.length}（未登录可见课表 && 门店非空）`);
  console.log(`  未启用        ${configs.length - on.length}（品牌关了未登录课表开关 或 今天无课）`);
  const byCity = {};
  on.forEach((c) => (byCity[c.studio.city] = (byCity[c.studio.city] || 0) + 1));
  console.log("  启用城市分布:", Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(", "));
})();
