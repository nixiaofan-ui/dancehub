/**
 * 门店城市校正（幂等，可重复执行）。
 *
 * 场景：库里的店挂在错误城市下。两类成因（都实测过）：
 *   ① 配置生成器判断城市**优先用坐标框**，而坐标框是方的 —— 广州的框
 *      (22.4,23.7,112.8,114.1) 把佛山整个包住，深圳框包住珠海。于是
 *      「DT舞蹈禅城店」（佛山市禅城区）被标成广州。
 *   ② 爱舞功用**品牌注册地**的行政区划码当城市（「爱舞功开发版」注册在北京、
 *      门店在广州）。
 * 后果：用户在广州列表里翻到佛山的店（距离排在最后），按「佛山」却一家都搜不到；
 * 而且区名是从地址按城市名抽取的（fill-district 的候选表按城市限定），城市错了
 * 区名必然跟着错。
 *
 * 判据：**地址里明确写了城市名才改**。地址是商家自己填的真地址，写着
 * 「佛山市禅城区」，比坐标框和注册地都权威。读不出城市（如「麦子店街53号」）
 * 就原样不动 —— 宁可不改，也不猜。
 *
 * ⚠ 只改 cityId，**不改店名**（与 calibrate-gsteps-city 的区别）：G-STEPS 的店名里带
 *   城市后缀（「G-STEPS·上海新天地店（北京）」），不改名下一轮就建新店；这批 16 条
 *   店名里不含城市后缀，只改 cityId 是安全的。若将来出现「店名带城市」的店，
 *   要连名字一起改（配置里的 legacyNames + renameStudios 那套）。
 *
 * ⚠ 不设「进程内只跑一次」：新抓进来的店可能又带错城市，所以每轮 tick 都扫一遍
 *   （6 小时节流，只读一次 findMany，成本可忽略）。启动时强制跑一次，且**必须排在
 *   ensureDistrict 之前** —— 区名候选表按城市限定，先校正城市才能抽对区。
 */
import { prisma } from "./prisma.js";
import { cityFromAddress } from "./city-names.js";
import { invalidateStudioIndex } from "./studio-index.js";

/** 与抓取刷新节奏一致的节流窗口（6 小时） */
const CALIBRATE_MS = 6 * 3600_000;
let lastRunAt = 0;

/**
 * 扫全库校正城市归属。
 *
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ checked: number, changed: number, skipped: number, createdCities: string[] }>}
 */
export async function calibrateStudioCity(opts = {}) {
  const log = opts.log || (() => {});

  const studios = await prisma.studio.findMany({
    where: { status: true, address: { not: null } },
    select: { id: true, name: true, cityId: true, address: true },
  });
  if (!studios.length) return { checked: 0, changed: 0, skipped: 0, createdCities: [] };

  const cities = await prisma.city.findMany({
    select: { id: true, name: true, region: true },
  });
  /** "CN|佛山" → cityId */
  const idByKey = new Map(cities.map((c) => [`${c.region}|${c.name}`, c.id]));
  const nameById = new Map(cities.map((c) => [c.id, c.name]));
  const regionById = new Map(cities.map((c) => [c.id, c.region]));

  let changed = 0;
  let skipped = 0;
  const createdCities = [];

  for (const s of studios) {
    // 海外店（首尔/东京/大阪）的地址抽不出中国城市名，天然被这条挡掉
    if (regionById.get(s.cityId) !== "CN") continue;

    const want = cityFromAddress(s.address);
    if (!want) {
      skipped += 1;
      continue;
    }
    const cur = nameById.get(s.cityId);
    if (cur === want) continue; // 幂等稳态：已经对了

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
      createdCities.push(want);
      log(`[city] 新建城市「${want}」`);
    }

    await prisma.studio.update({ where: { id: s.id }, data: { cityId: targetId } });
    changed += 1;
    log(`[city] #${s.id}「${s.name}」${cur} → ${want}（地址：${s.address}）`);
  }

  if (changed) {
    // 搜索索引按城市缓存（TTL 10min）：不失效的话，用户这几分钟里按新城市
    // 筛仍然是 0 条，按旧城市反而还能搜到
    invalidateStudioIndex();
    log(`[city] 门店城市校正：改了 ${changed} 家`);
  }
  return { checked: studios.length, changed, skipped, createdCities };
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
