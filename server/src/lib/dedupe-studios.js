/**
 * 同一家店被重复入库的自愈清理（幂等，可反复执行）。
 *
 * 为什么需要它：2026-09-29 老板在南京 D-DAY 舞蹈 的课时对比页看到**两家同名门店**
 * （都叫「总店」，一家 87 节一家 78 节），同屏对比时同一时段的课冒出来三节
 * （上游官方小程序只有一节）。查库发现是同一个 iWOD box 15299 被两份配置各建了一条：
 *
 *   iwod-15299-D-DAY        → 「D-DAY 舞蹈（秦淮）」  ← studios.auto.json，仍在抓
 *   iwod-15299-D-DAY-舞蹈   → 「D-DAY 舞蹈（市秦淮）」← studios.topcities.json，已停
 *
 * 停抓的那条不会被 pruneVanished 清理（清理只覆盖「本轮抓到过课的门店+日期」），
 * 于是它带着一整周的旧课表永远挂在库里：多一家门店、多一批约不到的课。
 * 另有 8 组是**并发插入**造成的：新配置上线的瞬间两个容器实例同时补跑，
 * findFirst 都说「没有」→ 各插一条同名同 appId 的记录（时间戳精确到同一秒）。
 *
 * 判重口径（三者全同才算同一家）：
 *   同城 + 同 bookingMiniAppId + 归一化后同名（只留字母数字汉字，并把「（市X）」里的
 *   那个「市」吃掉）
 * 「（市秦淮）」vs「（秦淮）」是配置生成器早期的 bug：地址「江苏省南京市秦淮区…」
 * 里紧挨着「区」的三个字是「市秦淮」，被当成了区名（grep 库里能搜出 105 个
 * 「（市XX）」尾巴的店名）。
 *
 * ⚠ 归一化的「（市」规则是无差别吃掉的 —— 包括真店名「囍瑜伽（市民之家店）」里的那个市，
 *   以及青岛合法的区名「市南」。这**无害**：canonStudioName 只用于**比较**，
 *   从不回写门店名，两边同样处理。想「精确只吃半截市名」反而会踩青岛「（市南）」
 *   这个合法区名（见 memory：青岛「市北/市南」跳过不是 bug）。别改。
 *
 * 判重口径分两类（2026-10-13 扩了第二类）：
 *
 *   A) **有 appId**（iWOD 系）：同城 + 同 appId + 归一化同名。appId 是强证据，够了。
 *   B) **无 appId**（gsteps / jiahe 这类不走小程序抓取、平台自研后端的）：
 *      同城 + 同 platform + 归一化同名，**且**这条链上至少有一方是「启用中配置的目标
 *      或它的分店」。
 *
 * ⛔ 为什么要补 B：A 的查询写死了 `bookingMiniAppId: { not: null }`，于是**无 appId 的
 *   抓取门店永远躲过归并**。2026-10-13 发现云端 G-STEPS·上海新天地店有 3 条
 *   （课 402 / 32 / 13），本地也有同样形态的重复。
 *   成因是 createStudioOnce 的并发复查：新配置上线时两个容器实例同时补跑，
 *   双方各自把课都写进去了 → 复查里「这条新记录还没挂数据才撤」的保护不成立 →
 *   两次都保留了（那条保护本身是对的，不能为了去重而删用户刚写进去的课）。
 *
 * 只合并 platform 相同的抓取门店：手录/补录店建店时 platform 写死 `OTHER`
 * （见 routes/import.routes.js），与抓取门店的 `WECHAT` 天然不同组，绝不会被顺手合并。
 * 两条都是 `OTHER` 的组（两家手录店同名）也一律跳过 —— 那是用户资产，不碰。
 *
 * 保留哪一条（按优先级）：
 *   1) 名字是某个**启用中**抓取配置的目标（或它的分店）→ 它才是还在被更新的那条
 *      ⚠ 用**归一化前缀**匹配：配置里写的是品牌名「G-STEPS」，库里是
 *        「G-STEPS·上海新天地店（上海）」——精确相等匹配不到（老实现就是等号，
 *        所以 G-STEPS 这类「品牌·分店（城市）」的店从来认不出自己的配置）
 *   2) 被关注数多的（用户资产多的那条）
 *   3) 最近被更新过的（MAX(schedule.updatedAt) 新）
 *      ⚠ 这条比「课多」可靠：抓取总是写同一条（findFirst 精确同名命中 id 最小的），
 *        所以活跃那条的日期总是最新，孤儿那条停在它被抛弃的那天
 *   4) id 小的（最早建的那条）
 *
 * 被合并的一方怎么处理：
 *   - Follow 迁到保留方（唯一键冲突的跳过，不重复关注）
 *   - 删掉它的课，但**只删没有预约/提醒、且不是用户手录的**（删了会连带删用户自己的记录）
 *   - 门店本身 status=false 软隐藏（可逆，且城市门店计数只统计 status=true）
 */
import { prisma } from "./prisma.js";

/** 门店名归一化：「D-DAY 舞蹈（市秦淮）」→「dday舞蹈秦淮」 */
export function canonStudioName(name) {
  return String(name || "")
    // ⚠ 这一条是**无差别**吃掉「（市」的（包括「（市民之家店）」的市、青岛「（市南）」
    //   的市）。无害：本函数只用于比较、从不回写门店名，且比较双方同样处理。
    //   改成「只管 1-3 字的半截市名」反而会把青岛合法区名「市南」误伤成「南」。
    .replace(/[（(]市/g, "（")
    // ⛔ 必须用 \p{L}\p{N}（任意语言的字母/数字），**不能**只写 [0-9A-Za-z\u4e00-\u9fa5]。
    //   2026-10-13 踩到的实况：海外店名「알티댄스 시흥사거리점」「리바이브스튜디오」
    //   「던 댄스 스튜디오」三家**完全不同的韩文店**，被老正则整条过滤成空串 →
    //   归一化后全都等于 "" → 同城同 platform 下碰撞成一组 → 差点把两家真店
    //   当成重复门店隐藏掉（还顺手删课）。日文假名店名同理。
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

/**
 * @param {{ log?: (msg: string) => void, targetNames?: Set<string>, dryRun?: boolean }} [opts]
 *   targetNames：启用中配置的目标店名集合。
 *     ⚠ 不给的话：① 「配置优先」这条排序规则失效；② **无 appId 的门店一律不合并**
 *     （它们的判重闸门就是「至少一方是这个集合的目标或分店」，没有集合就没有依据）。
 * @returns {Promise<{ groups: number, hidden: number, movedFollows: number, deletedSchedules: number }>}
 */
export async function dedupeStudios(opts = {}) {
  const log = opts.log || (() => {});
  const dryRun = !!opts.dryRun;
  const targetNames = opts.targetNames || null;

  // 启用中配置的「目标店名」归一化前缀（长度 <2 的丢弃：只写了「G」这种会命中一大片）
  const targetCanon = targetNames
    ? [...targetNames].map(canonStudioName).filter((t) => t.length >= 2)
    : null;
  /** 这条店名是不是某个启用配置的目标（或它的分店） */
  const isTarget = (name) => {
    if (!targetCanon || !targetCanon.length) return false;
    const c = canonStudioName(name);
    return targetCanon.some((t) => c === t || c.startsWith(t));
  };

  const studios = await prisma.studio.findMany({
    // 只看可见的：隐藏的要么是上一轮合并的结果，要么等人工确认，不必再动
    where: { status: true },
    select: {
      id: true,
      name: true,
      cityId: true,
      status: true,
      address: true,
      bookingMiniAppId: true,
      platform: true,
      _count: { select: { follows: true } },
    },
  });

  const groups = new Map();
  for (const s of studios) {
    const canon = canonStudioName(s.name);
    // 归一化后为空（纯符号 / 纯 emoji 店名）：没有可比的依据，**不进任何组**。
    // canonStudioName 现在保留所有语言的字母了，但这是最后一道保险 ——
    // 空串之间恒等，一旦放进去就是「所有空名店互相碰撞」。
    if (!canon) continue;
    const key = s.bookingMiniAppId
      ? // A) 有 appId：appId 本身就是「同一家店」的强证据
        `A|${s.cityId}|${s.bookingMiniAppId}|${canon}`
      : // B) 无 appId：靠 同城 + 同 platform + 同归一化名（后面还要过目标名这道闸）
        `P|${s.cityId}|${s.platform}|${canon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  let groupCount = 0;
  let hidden = 0;
  let movedFollows = 0;
  let deletedSchedules = 0;

  for (const [key, list] of groups) {
    // 原本这里是 `alive.length >= 2`（组里至少两条可见才动手）；查询已经
    // 只取可见的，所以长度即 alive 长度，等价且少一次过滤。
    if (list.length < 2) continue;

    // B 组的额外闸门：无 appId 的店证明力弱，要求「至少一条是启用配置的目标或它的分店」。
    // 否则两条来源不明的野数据（同一用户在同城手建了两条同名店之类）会被误并。
    if (key.startsWith("P|")) {
      if (!targetCanon || !list.some((s) => isTarget(s.name))) continue;
      // 两条都是手录店（platform=OTHER）→ 用户资产，不碰
      if (list[0].platform === "OTHER") continue;
    }

    const stats = new Map();
    for (const s of list) {
      const agg = await prisma.schedule.aggregate({
        where: { studioId: s.id },
        _count: { _all: true },
        _max: { updatedAt: true },
      });
      stats.set(s.id, {
        count: agg._count._all,
        lastAt: agg._max.updatedAt ? agg._max.updatedAt.getTime() : 0,
      });
    }

    const ranked = list.slice().sort((a, b) => {
      // 1) 是启用中配置的目标（或它的分店）→ 最优先
      const ta = isTarget(a.name) ? 1 : 0;
      const tb = isTarget(b.name) ? 1 : 0;
      if (ta !== tb) return tb - ta;

      // 2) 被关注数多的
      const fa = a._count.follows || 0;
      const fb = b._count.follows || 0;
      if (fa !== fb) return fb - fa;
      // 3) 最近更新过的
      const la = stats.get(a.id).lastAt;
      const lb = stats.get(b.id).lastAt;
      if (la !== lb) return lb - la;
      // 4) id 小的
      return a.id - b.id;
    });

    const keeper = ranked[0];
    groupCount += 1;
    const tag = list[0].bookingMiniAppId
      ? `appId ${list[0].bookingMiniAppId}`
      : `${list[0].platform} 无 appId`;
    log(
      `[dedupe] 重复门店（城 ${list[0].cityId} / ${tag} / ${canonStudioName(list[0].name)}）：` +
        `保留 #${keeper.id} ${keeper.name}` +
        `（课 ${stats.get(keeper.id).count}、关注 ${keeper._count.follows}），` +
        `合并 ${ranked.slice(1).map((s) => `#${s.id} ${s.name}`).join("、")}`,
    );
    if (dryRun) continue;

    for (const orphan of ranked.slice(1)) {
      // (a) 关注关系迁到保留方
      const follows = await prisma.follow.findMany({
        where: { studioId: orphan.id },
        select: { id: true, userId: true },
      });
      for (const f of follows) {
        await prisma.follow
          .create({ data: { userId: f.userId, studioId: keeper.id } })
          .then(() => {
            movedFollows += 1;
          })
          .catch(() => {
            /* 该用户已经关注了保留方：唯一键冲突，直接丢弃这条重复关注 */
          });
        await prisma.follow.delete({ where: { id: f.id } }).catch(() => {});
      }

      // (b) 删课：只删「上游已不做、也没人预约/提醒、也不是用户手录」的
      const victimSchedules = await prisma.schedule.findMany({
        where: {
          studioId: orphan.id,
          ownerId: null,
          bookings: { none: {} },
          reminders: { none: {} },
        },
        select: { id: true },
      });
      if (victimSchedules.length) {
        const res = await prisma.schedule.deleteMany({
          where: { id: { in: victimSchedules.map((s) => s.id) } },
        });
        deletedSchedules += res.count;
      }

      // (c) 门店软隐藏：城市门店计数、门店列表、时间轴都按 status=true 过滤
      await prisma.studio.update({ where: { id: orphan.id }, data: { status: false } });
      hidden += 1;

      const left = await prisma.schedule.count({ where: { studioId: orphan.id } });
      if (left) {
        log(`[dedupe] #${orphan.id} 仍保留 ${left} 节课（有预约/提醒或用户手录），已隐藏`);
      }
    }
  }

  if (groupCount) {
    log(
      `[dedupe] 合并 ${groupCount} 组重复门店：隐藏 ${hidden} 条、迁移关注 ${movedFollows} 条、清理旧课 ${deletedSchedules} 节`,
    );
  }
  return { groups: groupCount, hidden, movedFollows, deletedSchedules };
}
