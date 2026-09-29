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
 * 「（市XX）」尾巴的店名）。只吃「（市」开头的那一个市，不能无脑删所有「市」——
 * 真店名里有「囍瑜伽（市民之家店）」这种。
 *
 * 只合并「有 appId」的门店：手录店没有 appId，无法证明是同一家，一律不碰。
 *
 * 保留哪一条（按优先级）：
 *   1) 名字正好是某个**启用中**抓取配置的目标 → 它才是还在被更新的那条
 *   2) 被关注数多的（用户资产多的那条）
 *   3) 最近被更新过的（MAX(schedule.updatedAt) 新）
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
    // 只吃「（市X）」里的这个市 —— 那是配置生成器漏进来的半截市名（见文件头说明）。
    // 不能无脑删所有「市」：真店名里有「囍瑜伽（市民之家店）」这种。
    .replace(/[（(]市/g, "（")
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, "")
    .toLowerCase();
}

/**
 * @param {{ log?: (msg: string) => void, targetNames?: Set<string>, dryRun?: boolean }} [opts]
 *   targetNames：启用中配置的目标店名集合（不给则跳过「配置优先」这条规则）
 * @returns {Promise<{ groups: number, hidden: number, movedFollows: number, deletedSchedules: number }>}
 */
export async function dedupeStudios(opts = {}) {
  const log = opts.log || (() => {});
  const dryRun = !!opts.dryRun;
  const targetNames = opts.targetNames || null;

  const studios = await prisma.studio.findMany({
    where: { bookingMiniAppId: { not: null } },
    select: {
      id: true,
      name: true,
      cityId: true,
      status: true,
      address: true,
      bookingMiniAppId: true,
      _count: { select: { follows: true } },
    },
  });

  const groups = new Map();
  for (const s of studios) {
    if (!s.bookingMiniAppId) continue;
    const key = `${s.cityId}|${s.bookingMiniAppId}|${canonStudioName(s.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  let groupCount = 0;
  let hidden = 0;
  let movedFollows = 0;
  let deletedSchedules = 0;

  for (const [key, list] of groups) {
    if (list.length < 2) continue;

    // 只有「多条里至少还有一条活着」才值得动手；全被软隐藏的组等人工确认
    const alive = list.filter((s) => s.status);
    if (alive.length < 2) continue;

    const stats = new Map();
    for (const s of alive) {
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

    const ranked = alive.slice().sort((a, b) => {
      // 1) 是启用中配置的目标 → 最优先
      if (targetNames) {
        const ta = targetNames.has(a.name) ? 1 : 0;
        const tb = targetNames.has(b.name) ? 1 : 0;
        if (ta !== tb) return tb - ta;
      }
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
    log(
      `[dedupe] 重复门店 ${key}：保留 #${keeper.id} ${keeper.name}` +
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
