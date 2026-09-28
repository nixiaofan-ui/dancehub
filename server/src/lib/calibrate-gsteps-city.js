/**
 * 校准 G-STEPS 分店的城市归属与店名后缀（幂等，可重复执行）。
 *
 * 为什么需要它：G-STEPS 一次请求返回的是**全国**课表（北京 38 家 + 上海 2 家），
 * 早期抓取照抄了配置里的 `studio.city`（北京），于是上海新天地店、北外滩来福士店
 * 被挂到北京名下 —— 在北京界面里冒出上海分店。
 *
 * 校准依据是官方门店档案 `GET https://api.gsteps.cn/v2/studio/list` 的 city 字段，
 * 它明确给出 "北京市" / "上海市"。
 *
 * ⚠ 为什么**必须同时改名**：只改 cityId 而留着「（北京）」后缀的话，下一轮抓取
 * 拿到的店名是「G-STEPS·上海新天地店（上海）」，跟库里的旧名字对不上，会被当成
 * 新门店再插一条 —— 上海分店变成两条，其中一条是挂着旧名字的空壳。
 *
 * 挂进启动流程（而不是只做成手工脚本）的原因：云端库没法从本机改，而让老板为了
 * 跑一次校准去开云库公网不划算。启动时自愈一次，代价只有一个 HTTP 请求。
 */
import { prisma } from "./prisma.js";

const API = "https://api.gsteps.cn/v2/studio/list";

/** "北京市" → "北京"（库里 City.name 不带行政后缀） */
export function normalizeCityName(raw) {
  return String(raw || "").trim().replace(/(特别行政区|自治州|地区|市|县)$/, "");
}

/** "G-STEPS·上海新天地店（北京）" → { branch: "上海新天地店", suffix: "北京" } */
export function parseStudioName(name) {
  const m = /^G-STEPS·(.*?)（([^（）]*)）$/.exec(String(name || "").trim());
  if (!m) return null;
  return { branch: m[1], suffix: m[2] };
}

/**
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ checked: number, changed: number, official: number }>}
 */
export async function calibrateGstepsCity(opts = {}) {
  const log = opts.log || (() => {});

  const resp = await fetch(API, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`门店档案 HTTP ${resp.status}`);
  const body = await resp.json();
  const list = Array.isArray(body?.res) ? body.res : [];
  // 拿不到档案就什么都不做 —— 宁可不改，也不能凭猜测改错
  if (!list.length) return { checked: 0, changed: 0, official: 0 };

  const cityOf = new Map();
  for (const s of list) {
    const name = String(s.name || "").trim();
    if (!name) continue;
    cityOf.set(name, normalizeCityName(s.city || s.province || ""));
  }

  const studios = await prisma.studio.findMany({
    where: { name: { startsWith: "G-STEPS" } },
    select: { id: true, name: true, cityId: true },
  });
  if (!studios.length) return { checked: 0, changed: 0, official: cityOf.size };

  const cities = await prisma.city.findMany({ select: { id: true, name: true } });
  const cityIdByName = new Map(cities.map((c) => [c.name, c.id]));

  let changed = 0;
  for (const s of studios) {
    const parsed = parseStudioName(s.name);
    // 形如「G-STEPS·（北京）」的分店名为空的兜底记录，无从判定，保持原样
    if (!parsed) continue;
    const real = cityOf.get(parsed.branch);
    if (!real) continue;
    const targetId = cityIdByName.get(real);
    if (!targetId) continue;
    if (s.cityId === targetId && parsed.suffix === real) continue;

    await prisma.studio.update({
      where: { id: s.id },
      data: { cityId: targetId, name: `G-STEPS·${parsed.branch}（${real}）` },
    });
    changed += 1;
    log(`[calibrate] ${s.name} → ${real}`);
  }

  if (changed) log(`[calibrate] G-STEPS 分店城市校准：改了 ${changed} 家`);
  return { checked: studios.length, changed, official: cityOf.size };
}
