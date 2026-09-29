/**
 * 回填门店所在行政区（幂等，可重复执行）。
 *
 * 为什么需要它：发现页想按「海淀区」筛舞室，但库里没有这个维度 ——
 * `Studio.address` 95% 是空的，只有店名尾巴那个「（海淀）」带着区信息，
 * 覆盖率三成出头（北京 36% / 上海 31%），筛出来明显不全。
 *
 * 数据来源（按可信度）：
 *   ① `district-overrides.json`：scripts/build-district-overrides.mjs 回源菲云
 *      `/org/orglist` 拿到**完整地址**后抽的区名（上游最权威，且顺带把 address 补上）
 *   ② 库里已有的 address
 *   ③ 店名尾巴「（海淀）」—— 但要**按城市校验**是不是真区名，
 *      否则「（北京）」这种城市尾巴会被当成区（全国重名的两字短名一大堆）
 *
 * ⚠ 抽不到的一律留 null，不猜：前端把 null 归到「未标注」，并**显示数量**，
 *   让用户知道筛出来的不是全部，比悄悄给他一个看似完整、实际缺一半的列表要好。
 *
 * 挂在启动流程里是因为云端库没有公网入口，为了跑一次回填去开公网不划算。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./prisma.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRAWLER_DIR = path.resolve(HERE, "../crawler");

/** { "城市|门店名": { address, district, lngLat } } */
let overrides = null;
/** { 城市名: [区名…] } */
let areas = null;

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CRAWLER_DIR, file), "utf8"));
  } catch {
    return null;
  }
}

/** 「XX区 / XX县」优先，然后是裸名（上游地址常写成「北京朝阳10号线…」不带区） */
const SUFFIXES = ["新区", "特区", "区", "县", "市"];

function districtOf(address, city) {
  const a = String(address || "");
  if (!a) return "";
  const list = (areas && areas[city]) || [];
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

/** 店名末尾括号里那截：「D-DAY 舞蹈（秦淮）」→「秦淮」 */
const TAIL_RE = /[（(]\s*([^）)]{2,4})\s*[）)]\s*$/;

function districtOfName(name, city) {
  const m = String(name || "").trim().match(TAIL_RE);
  if (!m) return "";
  const tag = m[1];
  const list = (areas && areas[city]) || [];
  return list.includes(tag) ? tag : "";
}

/** 一个进程只跑一次 */
let done = false;

/**
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ checked: number, filled: number, addressed: number }>}
 */
export async function ensureDistrict(opts = {}) {
  if (done) return { checked: 0, filled: 0, addressed: 0 };
  done = true;

  const log = opts.log || (() => {});
  areas = loadJson("district-names.json");
  overrides = loadJson("district-overrides.json") || {};
  if (!areas) {
    log("[district] 缺 district-names.json，跳过回填");
    return { checked: 0, filled: 0, addressed: 0 };
  }

  // 只扫还没填的：填完后再启动就是空查询，几乎没有成本
  const rows = await prisma.studio.findMany({
    where: { district: null },
    select: { id: true, name: true, address: true, cityId: true },
  });
  if (!rows.length) return { checked: 0, filled: 0, addressed: 0 };

  const cityIdSet = [...new Set(rows.map((r) => r.cityId))];
  const cities = await prisma.city.findMany({
    where: { id: { in: cityIdSet } },
    select: { id: true, name: true },
  });
  const cityName = new Map(cities.map((c) => [c.id, c.name]));

  let filled = 0;
  let addressed = 0;
  for (const r of rows) {
    const city = cityName.get(r.cityId) || "";
    const ov = overrides[`${city}|${r.name}`] || null;
    const addr = String(r.address || "").trim();
    const patch = {};

    // 顺手把上游地址补回来：库里地址 95% 是空的，而它是后面所有定位的基础
    if (!addr && ov && ov.address) {
      patch.address = ov.address;
      addressed += 1;
    }
    const d =
      (ov && ov.district) ||
      districtOf(addr, city) ||
      (ov && districtOf(ov.address, city)) ||
      districtOfName(r.name, city);
    if (!d) continue;
    patch.district = d;
    await prisma.studio.update({ where: { id: r.id }, data: patch });
    filled += 1;
  }

  if (filled || addressed) {
    log(`[district] 行政区回填：定到区 ${filled} 家、补回地址 ${addressed} 家`);
  }
  return { checked: rows.length, filled, addressed };
}
