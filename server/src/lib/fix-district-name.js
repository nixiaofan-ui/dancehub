/**
 * 门店名自愈：洗掉区名前面那半个市（幂等，可重复执行）。
 *
 * 为什么需要它：配置生成器早期从地址「江苏省南京市秦淮区…」里切区名时，
 * 咬到了紧挨「区」的三个字「市秦淮」，于是库里出现 105 家
 * 「D-DAY 舞蹈（市秦淮）」这样的店 —— 名字难看是小事，真正的问题是它与
 * 另一份配置生成的「D-DAY 舞蹈（秦淮）」在库里变成两条门店，
 * 用户对比课表时看到的是两个库的并集（上游根本没有的课也被列出来）。
 *
 * 为什么挂在启动流程里：云端库没有公网入口，为了跑一次改名去开公网不划算；
 * 而配置侧的存量（studios.topcities.json）已经用同一个函数洗过并提交了，
 * 两边一致才不会出现「配置洗了、库里没洗 → 抓取又新建一条」。
 *
 * ⚠ 改名安全的前提：importer 找店时除了精确同名，还会用 canonStudioName
 *   （归一化时会吃掉「（市」）兜底，所以即使还有配置没跟上也不会新建空壳店。
 *
 * ⚠ 撞名不动：如果同城已经有一条洗完后的名字（多半是另一份配置建的同一家店），
 *   改过去会撞车，交给 maybeDedupeStudios 去合并，这里跳过。
 */
import { prisma } from "./prisma.js";
import { fixCityPrefixDistrict } from "./studio-name.js";

/** 一个进程只跑一次（启动自愈，别跟着每次请求重复扫表） */
let done = false;

/**
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ checked: number, changed: number, skipped: number }>}
 */
export async function fixStudioDistrictNames(opts = {}) {
  if (done) return { checked: 0, changed: 0, skipped: 0 };
  done = true;

  const log = opts.log || (() => {});
  const studios = await prisma.studio.findMany({
    where: {
      OR: [{ name: { contains: "（市" } }, { name: { contains: "(市" } }],
    },
    select: { id: true, name: true, cityId: true },
  });
  if (!studios.length) return { checked: 0, changed: 0, skipped: 0 };

  let changed = 0;
  let skipped = 0;
  for (const s of studios) {
    const after = fixCityPrefixDistrict(s.name);
    if (after === s.name) {
      skipped += 1; // 名字里带「市」但不是区名前缀（如「囍瑜伽（市民之家店）」）
      continue;
    }
    const clash = await prisma.studio.findFirst({
      where: { name: after, cityId: s.cityId },
      select: { id: true },
    });
    if (clash) {
      skipped += 1;
      log(`[fix-district] #${s.id} ${s.name} 洗完会撞上 #${clash.id}，跳过（交给重复门店自愈）`);
      continue;
    }
    await prisma.studio.update({ where: { id: s.id }, data: { name: after } });
    changed += 1;
    log(`[fix-district] #${s.id} ${s.name} → ${after}`);
  }

  if (changed) log(`[fix-district] 区名洗掉多余的「市」：改了 ${changed} 家`);
  return { checked: studios.length, changed, skipped };
}
