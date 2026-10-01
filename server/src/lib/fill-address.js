/**
 * 把抓取配置里写死的地址补进 Studio（幂等，可重复执行）。
 *
 * 为什么要它：`Studio.address` 常年只有 14% 有值，而配置里躺着 1100 条完整真地址
 * （「浙江省杭州市余杭区仓前街道向往街1118号」）。原因见 importer —— address 是
 * 配置**顶层**字段，建店时只展开了 config.studio，一条都没写进来。
 *
 * 地址是后面所有位置能力的地基：区名从地址抽（发现页按区筛）、坐标也从地址来
 * （距离排序）。所以它必须**排在 ensureDistrict() 之前**跑，否则这一轮抽完区，
 * 地址才补上，要等下次启动才生效。
 *
 * 只填**空地址**：库里已有的地址多半是上游实时拿的（比配置里写死的准），不去覆盖。
 *
 * 挂在启动流程里是因为云端库没有公网入口，为了跑一次回填去开公网不划算；
 * 而且配置是随代码上云的静态文件，云端重启一次就自动追平。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./prisma.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRAWLER_DIR = path.resolve(HERE, "../crawler");

/**
 * 一个进程只跑一次 —— 但**抓取流程会带 `force` 重跑**。
 *
 * 为什么需要 force：这个回填原本只挂在启动流程里，而云端容器启动时新接入的
 * 门店往往还不存在（抓取是启动后几分钟才跑），于是那批新店永远补不上，
 * 直到下次重启。表现是「地址/坐标/区名在本地都对、云端却是 null」。
 */
let done = false;

/** 地址里总得有个「路/街/号/楼」之类；配置里也有拿店名凑数当 address 的 */
const ADDR_HINT = /[路街道巷弄号楼层座区镇乡村园馆厦坊]/;
const JUNK = new Set(["无", "暂无", "待定", "-", "/", "unknown"]);

function looksLikeAddress(a) {
  if (!a || a.length < 6 || a.length > 120) return false;
  if (JUNK.has(a)) return false;
  return ADDR_HINT.test(a);
}

/** "城市|店名" -> address，来自 src/crawler/studios.*.json */
function loadConfigAddresses() {
  const map = new Map();
  let files = [];
  try {
    files = fs
      .readdirSync(CRAWLER_DIR)
      .filter((f) => /^studios\..+\.json$/.test(f));
  } catch {
    return map;
  }
  for (const f of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(path.join(CRAWLER_DIR, f), "utf8"));
    } catch {
      continue;
    }
    const list = Array.isArray(json) ? json : json.studios || [];
    for (const c of list) {
      if (!c || !c.studio) continue;
      const name = String(c.studio.name || "").trim();
      const city = String(c.studio.city || "").trim();
      const addr = String(c.address || "").trim();
      // 停抓的配置也补：地址是静态事实，店还在库里就还有用
      if (!name || !city || !looksLikeAddress(addr)) continue;
      const key = `${city}|${name}`;
      if (!map.has(key)) map.set(key, addr);
    }
  }
  return map;
}

/** 兜底匹配：店名可能有全半角/空格差异（「T-rex」vs「T－rex」） */
function canon(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")")
    .toLowerCase();
}

/**
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ checked: number, matched: number, filled: number }>}
 */
export async function ensureAddress(opts = {}) {
  if (done && !opts.force) return { checked: 0, matched: 0, filled: 0 };
  done = true;

  const log = opts.log || (() => {});
  const cfg = loadConfigAddresses();
  if (!cfg.size) {
    log("[address] 配置里没读到可用地址，跳过回填");
    return { checked: 0, matched: 0, filled: 0 };
  }

  // 只扫地址还是空的：填完之后再启动就是空查询，几乎零成本
  const rows = await prisma.studio.findMany({
    where: { OR: [{ address: null }, { address: "" }] },
    select: { id: true, name: true, cityId: true },
  });
  if (!rows.length) return { checked: 0, matched: 0, filled: 0 };

  const cities = await prisma.city.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.cityId))] } },
    select: { id: true, name: true },
  });
  const cityName = new Map(cities.map((c) => [c.id, c.name]));

  const canonIndex = new Map();
  for (const [k, v] of cfg) canonIndex.set(canon(k), v);

  let matched = 0;
  let filled = 0;
  for (const r of rows) {
    const city = cityName.get(r.cityId) || "";
    const addr = cfg.get(`${city}|${r.name}`) || canonIndex.get(canon(`${city}|${r.name}`));
    if (!addr) continue;
    matched += 1;
    await prisma.studio
      .update({ where: { id: r.id }, data: { address: addr } })
      .then(() => {
        filled += 1;
      })
      .catch(() => {});
  }

  if (filled) {
    log(`[address] 地址回填：${cfg.size} 条配置命中 ${matched} 家空地址门店，写入 ${filled} 家`);
  } else if (matched) {
    log(`[address] 地址回填：命中 ${matched} 家但写入全部失败`);
  }
  return { checked: rows.length, matched, filled };
}
