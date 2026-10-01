/**
 * 把上游直接给的经纬度补进 Studio（幂等，可重复执行）。
 *
 * 现阶段唯一来源是菲体云门店清单 `/org/orglist` 的 `lng_lat`，由
 * scripts/build-district-overrides.mjs 离线抓成静态表 district-overrides.json
 * （随代码上云，不在启动时现拉 —— 590 个场馆逐次请求会把启动拖垮）。
 *
 * ⚠ **菲云的 lngLat 是「经度,纬度」**，和习惯的 lat,lng 正好相反。用反了坐标会
 *   全落到非洲西海岸附近，而距离数字照样算得出来，只有把地图铺开才看得出不对。
 *
 * 其余平台（爱舞功 / iWOD / 飞兔）要么接口不给坐标，要么要靠地址做地理编码
 * （需要地图 key，老板暂不引入）——那些店这里不动，留 null。前端算不出距离的
 * 一律排在有距离的后面，绝不拿城市中心点顶替。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./prisma.js";

const CRAWLER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../crawler");

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CRAWLER_DIR, file), "utf8"));
  } catch {
    return null;
  }
}

/** 中国大致范围，用来挡住脏数据（反序、0 值、缺省） */
const LAT_RANGE = [3, 54];
const LNG_RANGE = [73, 136];

/** 一个进程只跑一次；抓取流程会带 `force` 重跑（见 fill-address.js 的说明） */
let done = false;

export async function ensureLatLng(opts = {}) {
  if (done && !opts.force) return { checked: 0, matched: 0, filled: 0 };
  done = true;

  const log = opts.log || (() => {});
  const overrides = loadJson("district-overrides.json") || null;
  if (!overrides || !Object.keys(overrides).length) {
    log("[latlng] 没有 district-overrides.json，跳过坐标回填");
    return { checked: 0, matched: 0, filled: 0 };
  }

  const rows = await prisma.studio.findMany({
    where: { lat: null },
    select: { id: true, name: true, cityId: true },
  });
  if (!rows.length) return { checked: 0, matched: 0, filled: 0 };

  const cities = await prisma.city.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.cityId))] } },
    select: { id: true, name: true },
  });
  const cityName = new Map(cities.map((c) => [c.id, c.name]));

  // 店名可能有全半角/空格差异，兜底再来一次
  const canonIndex = new Map();
  for (const [k, v] of Object.entries(overrides)) {
    if (v && v.lngLat) canonIndex.set(canonKey(k), v.lngLat);
  }

  let matched = 0;
  let filled = 0;
  let bad = 0;
  for (const r of rows) {
    const city = cityName.get(r.cityId) || "";
    const raw =
      (overrides[`${city}|${r.name}`] || {}).lngLat ||
      canonIndex.get(canonKey(`${city}|${r.name}`));
    if (!raw) continue;
    const [lngStr, latStr] = String(raw).split(",");
    const lng = Number(lngStr);
    const lat = Number(latStr);
    // 上游有 72 条是空坐标「,」。它们既不是命中也不是越界 —— 算进去的话每次
    // 启动都会打一条「77 条越界」的日志，看起来像一直在修一个修不好的问题
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) continue;
    matched += 1;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < LAT_RANGE[0] ||
      lat > LAT_RANGE[1] ||
      lng < LNG_RANGE[0] ||
      lng > LNG_RANGE[1]
    ) {
      bad += 1;
      continue;
    }
    await prisma.studio
      .update({ where: { id: r.id }, data: { lat, lng } })
      .then(() => {
        filled += 1;
      })
      .catch(() => {});
  }

  // 只在真写入时才出声：库里那几条越界脏坐标是既成事实，每次启动都报一遍
  // 只会让人以为服务一直在修同一个问题
  if (filled) {
    log(
      `[latlng] 坐标回填：命中 ${matched} 家，写入 ${filled} 家` +
        (bad ? `，${bad} 条坐标越界被丢弃` : ""),
    );
  }
  return { checked: rows.length, matched, filled };
}

function canonKey(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")")
    .toLowerCase();
}
