/**
 * 手工建档：把「抓不到、但用户应该搜得到」的门店建进库（幂等，可重复执行）。
 *
 * 为什么需要它：有些店用的是**课表带会员墙**或**闭源 SaaS**的平台，
 * 我们拿不到课表，但用户在这家店上课时仍然会来 DanceHub 搜 —— 搜不到会以为没收录。
 * 这类店按「先建档案、不排课」处理：库里有门店记录（地址/电话/行政区），课表为 0。
 * 同北京 SereneStar（有赞）的处理口径一致。
 *
 * 挂在启动流程里（与 ensureJiaheStores 一致）：云端库没法从本机改，
 * 启动时自愈一次，代价只有两条 SQL。
 *
 * ⚠ 只写确实拿到的信息（地址/电话来自门店官方页），**坐标不要猜** ——
 * 算不出距离的店排在有距离的后面即可，编一个坐标会让距离看起来是对的。
 *
 * 现状：
 * - 上海 INSPACE舞蹈工作室 —— 闻道软件（gm.wendaosoft.com），机构 id 835654。
 *   课表页 classtable/simpleclass/835654/325/{日期} 只对**该店会员**开放
 *   （非会员 200 + 「您还不是会员」，用真实会话复现也一样），故先只建档。
 *   档案来源：其官方「关于我们」页（徐汇区裕德路111号南洋1931商场三楼05B）。
 */
import { prisma } from "./prisma.js";
import { invalidateStudioIndex } from "./studio-index.js";

const MANUAL_STORES = [
  {
    name: "INSPACE舞蹈工作室",
    city: "上海",
    district: "徐汇",
    address: "上海市徐汇区裕德路111号南洋1931商场三楼05B",
    contact: "15221215905 / 15221213580",
    why: "闻道软件（wendaosoft）系统：课表只对会员开放，暂不排课",
  },
];

/**
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ created: number, skipped: number }>}
 */
export async function ensureManualStores(opts = {}) {
  const log = opts.log || (() => {});
  let created = 0;
  let skipped = 0;

  for (const s of MANUAL_STORES) {
    const city = await prisma.city.findFirst({ where: { name: s.city } });
    if (!city) {
      // 城市都没建过就别硬建门店（与 ensureJiaheStores 同一口径）
      log(`[建档] 跳过 ${s.name}：城市「${s.city}」还没建过`);
      skipped++;
      continue;
    }

    const exist = await prisma.studio.findFirst({
      where: { cityId: city.id, name: s.name },
      select: { id: true },
    });
    if (exist) {
      skipped++;
      continue;
    }

    await prisma.studio.create({
      data: {
        name: s.name,
        cityId: city.id,
        ...(s.address ? { address: s.address } : {}),
        ...(s.contact ? { contact: s.contact } : {}),
        ...(s.district ? { district: s.district } : {}),
      },
    });
    created++;
    log(`[建档] 新建门店 ${s.name}（${s.city}·${s.district}）：${s.why}`);
  }

  // 新店要立刻能被搜到：搜索走的是进程内归一化索引（TTL 10min），
  // 不主动失效就要等下一次 TTL 到期，用户这几分钟里搜品牌名会得到 0 条。
  if (created > 0) invalidateStudioIndex();

  return { created, skipped };
}
