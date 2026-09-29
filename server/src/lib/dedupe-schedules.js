import { prisma } from "./prisma.js";

/**
 * 课表重复自愈：同店 + 同日 + 同课名 + 同开始时间，只应存在一条。
 *
 * 为什么要单独做这件事（2026-09-29）：
 *   `Schedule` 表**没有任何唯一约束**（只有索引），去重全靠 `importer.upsertSchedule`
 *   先 `findMany` 再决定 create/update。两个问题叠在一起：
 *
 *   ① 产生：并发写（新配置上线瞬间多个抓取任务同时补跑同一家店）或上游字段微调导致
 *      匹配失败时，同一节课会被各插一条。
 *   ② 固化：`pruneVanished` 的指纹是「店 + 日 + 课名 + 起分」，**重复的两条指纹完全相同**，
 *      于是它们互相"证明"对方存在（都在 seen 里），谁都清不掉 —— 一旦产生就是永久的。
 *
 *   实测全库 710 家门店、16658 组重复、多出 16827 条课（占总量 17%）。
 *   表现就是用户在周课表上看到同一节课列两遍，一条带预约人数一条不带。
 *
 * 保留规则（一组里挑一条，其余删）：
 *   被预约/提醒引用 > 有真实预约人数 > updatedAt 新 > id 小
 * 待删条上的预约与提醒会先迁到保留条，不会连坐删掉用户自己的记录。
 *
 * 幂等：清干净后再跑一次为 0 组。
 */

// 单轮处理上限，防止一次把库里所有重复都拉进内存（首次全量清理时用）。
// 实测本地库 3081 个门店日 / 16656 组 ≈ 63 秒，云端数据量约两倍，
// 所以上限放到 2 万——够一次清完，又不至于让单轮跑到天荒地老。
// 真被截断也不要紧：下一轮（每小时）会接着剩下的做。
const MAX_PAIRS = 20000;

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/** 与 importer 的匹配口径一致：取 UTC 时分（@db.Time 在 Prisma 里读出来是 1970 UTC 时间） */
function hhmm(d) {
  const x = new Date(d);
  return `${String(x.getUTCHours()).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 课名归一化分组键。
 *
 * 必须做这一步：MySQL 的 `*_ai_ci` collation 把全角括号「（）」和半角「()」视为同一个字符，
 * 所以 SQL 侧 `GROUP BY courseName` 会把 `古典舞小舞段（望明月）` 和 `古典舞小舞段(望明月)`
 * 判成一组重复；而 JS 的 `===` 判成两个不同串 —— 两边口径不一致时，
 * SQL 说有重复、JS 说没有，那节课就永远清不掉（2026-09-29 实测卡在 studio 1057 上）。
 *
 * 顺带统一大小写、去掉所有空格与标点：`Jazz 入门` / `Jazz入门` / `jazz入门` 是同一节课。
 * 正常课名之间差异（初阶班 vs 高阶班、大班 vs 小班）不受影响。
 */
export function courseKey(name) {
  return String(name || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function refCount(row) {
  return (row._count?.bookings || 0) + (row._count?.reminders || 0);
}

/** 一组重复里挑出要保留的那条 */
function pickKeeper(rows) {
  return [...rows].sort((a, b) => {
    const ar = refCount(a) > 0 ? 1 : 0;
    const br = refCount(b) > 0 ? 1 : 0;
    if (ar !== br) return br - ar;
    const an = a.bookedNum != null ? 1 : 0;
    const bn = b.bookedNum != null ? 1 : 0;
    if (an !== bn) return bn - an;
    const at = new Date(a.updatedAt).getTime();
    const bt = new Date(b.updatedAt).getTime();
    if (at !== bt) return bt - at;
    return a.id - b.id;
  })[0];
}

/**
 * 把待删条上的预约 / 提醒迁到保留条。
 *
 * 两张表都有 `@@unique([userId, scheduleId])`，所以逐一迁移：
 * 同一个用户对「重复的两条」各操作过一次时，保留条上已有一条，
 * 直接删掉待删条上那条多余记录（对用户来说本来就是同一节课）。
 */
async function moveRefs(fromId, toId, stats) {
  const bookings = await prisma.booking.findMany({
    where: { scheduleId: fromId },
    select: { id: true, userId: true },
  });
  for (const b of bookings) {
    const dup = await prisma.booking.findFirst({
      where: { scheduleId: toId, userId: b.userId },
      select: { id: true },
    });
    if (dup) {
      await prisma.booking.delete({ where: { id: b.id } });
      stats.droppedBookings++;
    } else {
      await prisma.booking.update({ where: { id: b.id }, data: { scheduleId: toId } });
      stats.movedBookings++;
    }
  }

  const reminders = await prisma.reminder.findMany({
    where: { scheduleId: fromId },
    select: { id: true, userId: true },
  });
  for (const r of reminders) {
    const dup = await prisma.reminder.findFirst({
      where: { scheduleId: toId, userId: r.userId },
      select: { id: true },
    });
    if (dup) {
      await prisma.reminder.delete({ where: { id: r.id } });
      stats.droppedReminders++;
    } else {
      await prisma.reminder.update({ where: { id: r.id }, data: { scheduleId: toId } });
      stats.movedReminders++;
    }
  }
}

/** 保留条缺的软字段，从被删的那些里补回来（别把已有的真实人数丢掉） */
async function enrichKeeper(keep, others) {
  const patch = {};
  if (keep.bookedNum == null) {
    const v = others.find((o) => o.bookedNum != null);
    if (v) patch.bookedNum = v.bookedNum;
  }
  if (!keep.coursePicUrl) {
    const v = others.find((o) => o.coursePicUrl);
    if (v) patch.coursePicUrl = v.coursePicUrl;
  }
  if (!keep.coachId) {
    const v = others.find((o) => o.coachId);
    if (v) patch.coachId = v.coachId;
  }
  if (Object.keys(patch).length) {
    await prisma.schedule.update({ where: { id: keep.id }, data: patch });
  }
}

/**
 * 把一组重复课合并成一条，返回保留的那条 id。
 *
 * 导出给 `importer.upsertSchedule` 复用：抓取时若发现库里同一节课有多条
 * （历史遗留、或本轮并发刚插进去的），顺手合并掉，不用等小时级的自愈任务 ——
 * 用户下次刷新课表就已经是一节了。
 *
 * @param {Array} group 同一节课的多条记录（建议带 `_count.bookings/reminders`）
 * @param {{dryRun?: boolean}} [opts]
 */
export async function collapseGroup(group, opts = {}) {
  const stats = { movedBookings: 0, movedReminders: 0, droppedBookings: 0, droppedReminders: 0 };
  if (!group.length) return { keepId: null, removed: 0, ...stats };
  if (group.length < 2) return { keepId: group[0].id, removed: 0, ...stats };

  const keep = pickKeeper(group);
  const stale = group.filter((g) => g.id !== keep.id);
  if (opts.dryRun) return { keepId: keep.id, removed: stale.length, ...stats };

  await enrichKeeper(keep, stale);

  // 调用方没带 _count 时（例如 importer 直接把自己查出来的记录丢进来），
  // 光看记录本身判断不出「这条有没有被预约/提醒」，那就一律走一遍迁移 ——
  // moveRefs 内部先 findMany，没有引用时什么都不做，代价只是两次查询。
  // 绝不能不迁移就删：Booking/Reminder 对 Schedule 是必需品外键，删除会直接报错。
  const needsCheck = !group.some((r) => r._count);
  for (const s of stale) {
    if (needsCheck || refCount(s) > 0) await moveRefs(s.id, keep.id, stats);
  }

  await prisma.schedule.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  return { keepId: keep.id, removed: stale.length, ...stats };
}

/**
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{pairs:number, groups:number, removed:number, movedBookings:number,
 *   movedReminders:number, droppedBookings:number, droppedReminders:number,
 *   truncated:boolean, ms:number}>}
 */
export async function dedupeSchedules(opts = {}) {
  const dryRun = !!opts.dryRun;
  const started = Date.now();
  const stats = {
    pairs: 0,
    groups: 0,
    removed: 0,
    movedBookings: 0,
    movedReminders: 0,
    droppedBookings: 0,
    droppedReminders: 0,
    truncated: false,
    ms: 0,
  };

  // ① 先用 SQL 定位「哪家店哪一天可能有重复」——不要把整张表拉进进程。
  //
  // 分组口径要和下面 JS 的 courseKey 对齐，否则会出现两种漏判：
  //   - 只按 courseName 分组：`Jazz 入门` 与 `Jazz入门` 在 DB 里是两个不同的串，
  //     SQL 判不出重复 → 整晚漏掉（所以这里先 REPLACE 掉半角/全角空格。
  //     全角空格 U+3000 用 `_utf8mb4 0xE38080` 写死，避免受连接字符集影响）
  //   - 直接 GROUP BY startTime 太宽：同店同时间通常有 3–5 门不同的课，
  //     会把全库 13822 个门店日全拉进来（实测），绝大多数白跑
  const dupKeys = await prisma.$queryRaw`
    SELECT studioId, scheduleDate
    FROM Schedule
    WHERE ownerId IS NULL
    GROUP BY studioId, scheduleDate,
             REPLACE(REPLACE(courseName, ' ', ''), _utf8mb4 0xE38080, ''),
             startTime
    HAVING COUNT(*) > 1
  `;

  const pairs = new Map();
  for (const r of dupKeys) {
    const key = `${r.studioId}|${dayKey(r.scheduleDate)}`;
    if (!pairs.has(key)) {
      pairs.set(key, { studioId: Number(r.studioId), day: dayKey(r.scheduleDate) });
    }
  }
  stats.pairs = pairs.size;
  if (!pairs.size) {
    stats.ms = Date.now() - started;
    return stats;
  }

  let processed = 0;
  for (const p of pairs.values()) {
    if (++processed > MAX_PAIRS) {
      stats.truncated = true;
      break;
    }

    const rows = await prisma.schedule.findMany({
      where: {
        studioId: p.studioId,
        scheduleDate: new Date(`${p.day}T00:00:00Z`),
        ownerId: null, // 用户手录的课不碰：那是私有数据，重复也是他自己录的
      },
      include: { _count: { select: { bookings: true, reminders: true } } },
    });

    const byKey = new Map();
    for (const r of rows) {
      const k = `${courseKey(r.courseName)}|${hhmm(r.startTime)}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }

    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      stats.groups++;

      const r = await collapseGroup(group, { dryRun });
      stats.removed += r.removed;
      stats.movedBookings += r.movedBookings;
      stats.movedReminders += r.movedReminders;
      stats.droppedBookings += r.droppedBookings;
      stats.droppedReminders += r.droppedReminders;
    }
  }

  // 库里少了这么多课，城市时间轴的缓存（TIMELINE_TTL = 5 分钟）里可能还留着
  // 带重复的旧结果 —— 顺手清掉，否则用户刷新完还是看到两行，以为没修好。
  // 用动态 import：schedule.service 在依赖图上比这里靠上，静态引容易绕出环。
  if (stats.removed) {
    try {
      const { invalidateTimelineCache } = await import("../services/schedule.service.js");
      await invalidateTimelineCache();
    } catch (err) {
      console.warn(`[dedupe-schedules] 缓存失效失败：${err.message}`);
    }
  }

  stats.ms = Date.now() - started;
  return stats;
}

/**
 * 轻量入口：节流 + 吞异常，供启动流程与抓取心跳调用。
 *
 * 首次调用必然执行（lastRunAt 初值为 0），之后每小时间隔一次 ——
 * 全库扫一遍在云端是分钟级的，不能每 5 分钟的心跳都做；而重复一旦被
 * `upsertSchedule` 堵住源头（同轮合并），每小时一次的增量成本几乎为零。
 *
 * 自愈失败绝不能把抓取或服务启动带崩，所以异常一律吞掉只打日志。
 */
let lastRunAt = 0;
const INTERVAL_MS = 3600_000;

export async function maybeDedupeSchedules(reason = "") {
  if (String(process.env.DEDUPE_SCHEDULES ?? "1") === "0") return null;
  if (lastRunAt && Date.now() - lastRunAt < INTERVAL_MS) return null;
  lastRunAt = Date.now();
  try {
    const res = await dedupeSchedules();
    if (res.removed) {
      console.log(
        `[dedupe-schedules]${reason ? ` (${reason})` : ""} ${res.pairs} 个门店日 / ` +
          `${res.groups} 组重复 → 删除 ${res.removed} 条（迁预约 ${res.movedBookings}、` +
          `迁提醒 ${res.movedReminders}）耗时 ${res.ms}ms`,
      );
    }
    return res;
  } catch (err) {
    console.warn(`[dedupe-schedules] 失败：${err.message}`);
    return null;
  }
}
