/**
 * 嘉禾舞社：把门店档案里的全部门店建进库（幂等，可重复执行）。
 *
 * 为什么需要它：嘉禾的课表接口 `/v1.0.0/courses` **只返回当天有课的门店**，
 * 当天没排课的分店（如 2026-09 新开的马家堡店）会整个从库里消失 ——
 * 用户翻门店列表以为没接入。门店档案 `/v1.0.0/stores` 有完整 13 家，
 * 抓课时已经会顺带建店，但云端库里的存量缺口还得补一次。
 *
 * 同样挂在启动流程里（与 calibrate-gsteps-city 一致）：云端库没法从本机改，
 * 启动时自愈一次，代价只有一个 HTTP 请求。
 *
 * ⚠ 必须幂等且「拿不到权威数据就什么都不做」——宁可不建，也不能凭猜测建错店。
 */
import { prisma } from "./prisma.js";

const API = "https://app.jiahewushe.com/v1.0.0/stores";
const BRAND = "嘉禾舞社";

/** "北京市海淀区…" → "北京"；匹配不到返回空（交给调用方回落） */
function guessCityFromAddress(addr) {
  const m = String(addr || "").trim().match(/^([\u4e00-\u9fa5]{2,4}?)[市省]/);
  return m ? m[1] : "";
}

/**
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ official: number, created: number }>}
 */
export async function ensureJiaheStores(opts = {}) {
  const log = opts.log || (() => {});

  const resp = await fetch(API, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`嘉禾门店档案 HTTP ${resp.status}`);
  const list = await resp.json();
  if (!Array.isArray(list) || !list.length) return { official: 0, created: 0 };

  // 库里已有的同名门店不重复建
  const existing = await prisma.studio.findMany({
    where: { name: { startsWith: BRAND } },
    select: { name: true },
  });
  const have = new Set(existing.map((s) => s.name));

  let created = 0;
  for (const s of list) {
    const branch = String(s.store_name || "").trim();
    if (!branch) continue;
    const name = `${BRAND}·${branch}`;
    if (have.has(name)) continue;

    const cityName = guessCityFromAddress(s.address) || "北京";
    const city = await prisma.city.findFirst({ where: { name: cityName } });
    if (!city) continue; // 城市都没建过就别硬建门店，等抓取器正常跑一轮

    await prisma.studio.create({
      data: {
        name,
        cityId: city.id,
        address: String(s.address || "").trim() || null,
        platform: "WECHAT",
        status: true,
      },
    });
    created += 1;
  }

  if (created) log(`[dancehub] 嘉禾门店补齐：新建 ${created} 家（档案共 ${list.length} 家）`);
  return { official: list.length, created };
}
