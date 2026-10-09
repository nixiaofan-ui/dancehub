/**
 * 批量导入：把映射后的条目写入数据库
 * - studio / coach 按名称幂等（存在即复用，不存在则创建）
 * - schedule 按「studio + date + courseName + startTime」upsert（存在则更新）
 */
import { prisma } from "../lib/prisma.js";
import { canonStudioName } from "../lib/dedupe-studios.js";
import { collapseGroup, courseKey } from "../lib/dedupe-schedules.js";
import { invalidateTimelineCache } from "../services/schedule.service.js";
import { invalidateStudioIndex } from "../lib/studio-index.js";
import { mapRawToSchedule } from "./mapper.js";

/** 按地区+名称幂等创建城市（全国扩展：新城市自动建） */
export async function findOrCreateCity(region, name) {
  const existing = await prisma.city.findFirst({
    where: { region: region || "CN", name: name || "上海" },
  });
  if (existing) return existing;
  return prisma.city.create({
    data: { region: region || "CN", name: name || "上海" },
  });
}

/**
 * 平台类型兜底：配置没写 platform 时按地区推断。
 * 海外场馆一律不是微信小程序 —— 若标成 WECHAT，前端会把用户引导去
 * 「微信搜索该舞室官方小程序」，韩国舞室根本没有，是错误引导。
 */
function resolvePlatform(studioRef) {
  if (studioRef.platform) return studioRef.platform;
  return studioRef.region === "OVERSEAS" ? "OTHER" : "WECHAT";
}

/**
 * 经纬度清洗（坐标能不能入库的最后一道闸）。
 *
 * ⚠ 上游把「经度,纬度」写反是**真实发生过**的事故（菲体云的 lng_lat 就是反的），
 *   反了坐标会落到非洲西海岸，而距离数字照样算得出来、界面上看不出任何异常，
 *   只有把地图铺开才发现不对。所以这里不修正、只丢弃 —— 宁缺勿错。
 * - 国内店（region 非 OVERSEAS）：必须落在中国大致范围内才算数，
 *   反序值必然出界 → 自然被挡掉；
 * - 海外店：只做 ±90 / ±180 的合法性检查（首尔、东京都在国内范围之外）。
 */
function sanitizeLatLng(lat, lng, region) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  if (region !== "OVERSEAS" && (a < 3 || a > 54 || b < 73 || b > 136)) return null;
  return { lat: a, lng: b };
}

export async function findOrCreateStudio(studioRef, extra = {}) {
  const existing = await resolveExistingStudio(studioRef);
  // 跳转小程序 appId / 官网地址等新字段：已有店也补写
  // （只在新值非空且不同才更新，减少无谓写入）
  const patch = {};
  if (!existing) {
    const city = await findOrCreateCity(studioRef.region, studioRef.city);
    return createStudioOnce(studioRef, extra, city);
  }

  if (extra.bookingMiniAppId && existing.bookingMiniAppId !== extra.bookingMiniAppId) {
    patch.bookingMiniAppId = extra.bookingMiniAppId;
  }
  if (studioRef.officialUrl && existing.officialUrl !== studioRef.officialUrl) {
    patch.officialUrl = studioRef.officialUrl;
  }
  // 已入库的海外店可能是在 platform 兜底逻辑加上之前建的，被标成了 WECHAT，
  // 这里一并纠正（只纠正海外店，国内店的 platform 以库里为准）
  const wantPlatform = resolvePlatform(studioRef);
  if (
    studioRef.region === "OVERSEAS" &&
    existing.platform === "WECHAT" &&
    wantPlatform !== "WECHAT"
  ) {
    patch.platform = wantPlatform;
  }
  if (studioRef.address && !existing.address) patch.address = studioRef.address;
  // 电话同理只填空值：上游偶尔不给 phone，不能把已经拿到（或人工补的）号码擦掉
  if (studioRef.contact && !existing.contact) patch.contact = studioRef.contact;
  // 坐标：只在库里还是空的时候补（有值不动，避免把人工校准过的坐标覆盖掉）
  if ((existing.lat == null || existing.lng == null) && Number.isFinite(studioRef.lat) && Number.isFinite(studioRef.lng)) {
    patch.lat = studioRef.lat;
    patch.lng = studioRef.lng;
  }

  if (Object.keys(patch).length) {
    return prisma.studio.update({ where: { id: existing.id }, data: patch });
  }
  return existing;
}

/**
 * 找「已经存在的同一家店」。
 *
 * 第一优先：店名完全一致（历史行为，绝大多数配置都命中这条）。
 * 兜底：同城 + **归一化同名**（只留字母数字汉字并去掉「市」）。
 *
 * 为什么需要兜底：配置生成器早期有「取的市字多一位」的 bug，同一个 iWOD box
 * 被两个脚本扫到时生成了「D-DAY 舞蹈（市秦淮）」和「D-DAY 舞蹈（秦淮）」两个名字，
 * 精确匹配落空 → 又建了一条门店，于是用户在对比页看到两家同名门店，
 * 课表是两个库的并集（同屏出现上游根本没有的课）。这 105 个「（市XX）」店名
 * 就是这么来的（2026-09-29 老板在南京 D-DAY 发现）。
 *
 * ⚠ 只复用、**不改名**：改名会让历史数据与配置再次对不上（G-STEPS 城市校准
 * 那次踩过：只改 cityId 不改名 → 下一轮抓取又建一条空壳店）。
 */
async function resolveExistingStudio(studioRef) {
  const name = String(studioRef.name || "").trim();
  if (!name) return null;

  // ① 同名且可见
  const exact = await prisma.studio.findFirst({ where: { name, status: true } });
  if (exact) return exact;

  const city = await findOrCreateCity(studioRef.region, studioRef.city);
  const siblings = await prisma.studio.findMany({
    where: { cityId: city.id },
    select: { id: true, name: true, status: true },
  });
  const want = canonStudioName(name);
  const sameCanon = siblings.filter((s) => canonStudioName(s.name) === want);

  // ② 归一化同名且可见 —— 最常见的就是「（市秦淮）」撞上「（秦淮）」
  const visible = sameCanon.find((s) => s.status);
  if (visible) {
    if (visible.name !== name) {
      console.warn(
        `[importer] 「${name}」与库内 #${visible.id}「${visible.name}」视为同一家店，复用而非新建`,
      );
    }
    return visible;
  }

  // ③ 只剩被隐藏的记录（上一轮 dedupe 合并掉的重复项）→ 复用，别新建第三条。
  //    这里不再把它改回可见：同城已经没有其他可见的同族门店，说明它自己才是活的，
  //    dedupe 只会在「有可见的同族门店」时才隐藏东西，所以这里唤醒是安全的；
  //    反之（有可见同族）已经在上一步返回了，不会出现两条互相唤醒来回翻的状态。
  const hidden = sameCanon.find((s) => s.name === name) || sameCanon[0];
  if (hidden) {
    await prisma.studio
      .update({ where: { id: hidden.id }, data: { status: true } })
      .catch(() => {});
    console.warn(`[importer] 「${name}」复用此前被合并隐藏的 #${hidden.id}，已重新置为可见`);
    return hidden;
  }
  return null;
}

/**
 * 建店 —— 并且保证「同一家店只会留下一条」。
 *
 * 并发场景：新配置上线的瞬间，新旧两个容器实例都会补跑同一份配置，
 * 两边 findFirst 都说「没有这家店」→ 各插一条同名记录（2026-09-29 抓到 8 组，
 * 时间戳精确到同一秒）。这里在 create 之后复查一次同名记录：谁 id 大谁把自己
 * 撤掉，两边结论一致，结果是幂等的。
 */
async function createStudioOnce(studioRef, extra, city) {
  const created = await prisma.studio.create({
    data: {
      name: studioRef.name,
      cityId: city.id,
      address: studioRef.address || null,
      contact: studioRef.contact || null,
      lat: Number.isFinite(studioRef.lat) ? studioRef.lat : null,
      lng: Number.isFinite(studioRef.lng) ? studioRef.lng : null,
      platform: resolvePlatform(studioRef),
      status: true,
      bookingMiniAppId: extra.bookingMiniAppId || null,
      officialUrl: studioRef.officialUrl || null,
    },
  });
  // 搜得到的前提是索引里有它 —— 新接入的舞室不能等 10 分钟 TTL
  invalidateStudioIndex();

  const twins = await prisma.studio.findMany({
    where: { cityId: city.id, name: studioRef.name },
    select: { id: true },
  });
  if (twins.length < 2) return created;

  const keepId = Math.min(...twins.map((t) => t.id));
  if (keepId === created.id) return created;

  // 只在「这条新记录还没挂任何数据」时撤掉它，避免删掉刚写进去的课
  const [schedules, coaches, follows] = await Promise.all([
    prisma.schedule.count({ where: { studioId: created.id } }),
    prisma.coach.count({ where: { studioId: created.id } }),
    prisma.follow.count({ where: { studioId: created.id } }),
  ]);
  if (schedules || coaches || follows) return created;

  await prisma.studio.delete({ where: { id: created.id } }).catch(() => {});
  const kept = await prisma.studio.findUnique({ where: { id: keepId } });
  if (kept) {
    console.warn(`[importer] 并发建店：撤掉重复的 #${created.id}，复用 #${kept.id}「${kept.name}」`);
  }
  return kept || created;
}

/**
 * 找（或建）这家店的教练。
 *
 * @param {number} studioId
 * @param {string} name
 * @param {string|null} avatarUrl 本次抓到的头像；null 表示「这平台不给头像」
 *
 * ⚠ 头像只在**库里还没有**时才写。上游偶发不返回（接口抖一下、字段改版）时
 *   如果拿 null 覆盖，已有的头像会被一次性擦掉，而且很可能再也补不回来
 *   —— 老师换头像的概率远低于接口抖动。这和 keepOldOnMissing 保护软字段同理。
 */
export async function findOrCreateCoach(studioId, name, avatarUrl = null) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const existing = await prisma.coach.findFirst({ where: { studioId, name: trimmed } });
  if (existing) {
    if (avatarUrl && !existing.avatarUrl) {
      const updated = await prisma.coach.update({
        where: { id: existing.id },
        data: { avatarUrl },
      });
      return updated;
    }
    return existing;
  }
  return prisma.coach.create({
    data: { studioId, name: trimmed, avatarUrl: avatarUrl || null },
  });
}

/**
 * 更新时「上游没给」的字段保留库里的旧值，不要拿 null 去覆盖。
 *
 * 为什么必须这样：`update({ data: entry })` 是全量覆写，而 entry 里
 * bookedNum / coursePicUrl 是「这次抓不到就为 null」的软字段 ——
 * 平台偶发不返回（接口抖一下、字段被改版）时，库里已经拿到的真实人数
 * 和封面图会被一次性擦掉，用户看到的就是「没有数字」且再也回不来
 * （下一轮抓取如果又正常，才可能补回）。
 *
 * 注意只保护**软字段**：课名、时间、教练这些是权威字段，上游说变就是变了。
 */
function keepOldOnMissing(entry, existing) {
  const patch = { ...entry };
  if (patch.bookedNum == null && existing.bookedNum != null) {
    patch.bookedNum = existing.bookedNum;
  }
  if (!patch.coursePicUrl && existing.coursePicUrl) {
    patch.coursePicUrl = existing.coursePicUrl;
  }
  return patch;
}

/**
 * 把一组「同一节课」的候选行合并掉并写入最新数据，返回 updated 结果。
 * upsertSchedule 的三个分支（同教练命中 / 换老师合并 / 库里已有重复）共用。
 */
async function updateCollapsed(rows, entry) {
  let merged = 0;
  let keep = rows[0];
  if (rows.length > 1) {
    const { keepId } = await collapseGroup(rows);
    keep = rows.find((m) => m.id === keepId) || rows[0];
    merged = rows.length - 1;
  }
  await prisma.schedule.update({
    where: { id: keep.id },
    data: keepOldOnMissing(entry, keep),
  });
  return { action: "updated", id: keep.id, ...(merged ? { merged } : {}) };
}

export async function upsertSchedule(entry, { ambiguous = false } = {}) {
  const eh = entry.startTime.getUTCHours();
  const em = entry.startTime.getUTCMinutes();
  const sameSlot = (c) =>
    c.startTime.getUTCHours() === eh && c.startTime.getUTCMinutes() === em;

  // ① 精确匹配（绝大多数情况）。@db.Time 列过滤在 Prisma/MySQL 下不可靠，
  //    改为按日期+课程拉取后 JS 比对 UTC 时分。
  const candidates = await prisma.schedule.findMany({
    where: {
      studioId: entry.studioId,
      scheduleDate: entry.scheduleDate,
      courseName: entry.courseName,
    },
  });
  let matched = candidates.filter(sameSlot);

  // ② 精确匹配落空 → 用「归一化课名」在本店本日再找一遍。
  //    上游把课名从 `古典舞（望明月）` 改成 `古典舞(望明月)`（全角括号→半角），
  //    或把 `Jazz 入门` 的空格去掉时，精确匹配必然落空；若不做这一步，
  //    每轮抓取都会新建一条、pruneVanished 再把旧那条删掉 —— 同一节课的 id 天天变，
  //    挂在旧 id 上的用户预约/提醒也跟着一起没。归一化口径必须与
  //    dedupe-schedules 的 courseKey 完全一致（NFKC + 去标点），否则两边会互相打架。
  if (!matched.length) {
    const dayRows = await prisma.schedule.findMany({
      where: {
        studioId: entry.studioId,
        scheduleDate: entry.scheduleDate,
        ownerId: null, // 用户手录的课不认领
      },
    });
    const want = courseKey(entry.courseName);
    matched = dayRows.filter((c) => courseKey(c.courseName) === want && sameSlot(c));
  }

  // ③ 同名同时刻可能不止一个班：OG Dance 的「特邀导师」Bala 和酸酸同在
  //    18:30-20:00 开课（各占一个教室、各自名额）。老的匹配键不含教练，
  //    两个班会先后写进同一行，后写的把先写的顶掉 —— Bala 的课在我们课表上
  //    凭空消失，用户对着舞室小程序数不出我们少的那节（2026-10-04 反馈）。
  //    现在优先认同教练的行；没有同教练的行时再看本轮语境：
  //    - 本轮该时段只有一个同名班 → 视为「换老师」，合并进原行（保 id，
  //      用户挂在上面的预约/提醒不连坐）—— 这是老行为的保留；
  //    - 本轮该时段有多个同名班（ambiguous）→ 必须新建一行，不能顶掉别人。
  if (entry.coachId != null) {
    const mine = matched.filter((c) => c.coachId === entry.coachId);
    if (mine.length) return updateCollapsed(mine, entry);
    if (matched.length && !ambiguous) return updateCollapsed(matched, entry);
    // ambiguous 且没有本教练的行 → 落到下面 create
  } else if (matched.length) {
    // 平台不给教练（coachId 为 null）时维持老口径：按 课名+时分 匹配
    return updateCollapsed(matched, entry);
  }

  const created = await prisma.schedule.create({ data: entry });
  return { action: "created", id: created.id };
}

/**
 * 幂等键：与 upsertSchedule 的匹配口径保持一致（门店 + 日期 + 课名 + 开始时分 + 教练）。
 * 用「课程指纹」而不是自增 id 来记「本轮抓到过什么」，
 * 这样即使 upsert 中途跳过了某条，也不会把库里那节课误判成已消失。
 *
 * 教练必须进指纹：同名同时刻的双班（OG Dance「特邀导师」Bala/酸酸）是两节
 * 独立的课，上游只取消其中一个时，不带教练的指纹会把库里另一节也判成「还在」，
 * 幽灵课永远清不掉。
 */
function fingerprint(studioId, scheduleDate, courseName, startTime, coachId = null) {
  const day = scheduleDate.toISOString().slice(0, 10);
  const hh = String(startTime.getUTCHours()).padStart(2, "0");
  const mm = String(startTime.getUTCMinutes()).padStart(2, "0");
  return `${studioId}|${day}|${courseName}|${hh}:${mm}|${coachId ?? "-"}`;
}

/**
 * 清理「上游已经没有了、但库里还留着」的课。
 *
 * 为什么必须清：抓取一直只做 upsert，从不删除。舞室改课表（换老师、改课名、
 * 直接把课挪走）之后，旧记录会永远留在库里。2026-09-29 实测 MAX POWER 陆家嘴店
 * 9/29 12:00 这个时段：上游只有 1 节课，我们库里挤了 6 节 —— 用户点进去看课表，
 * 多出来那 5 节在官方的约课系统里根本约不到，比没接还糟。
 *
 * 判定范围以**本轮抓取窗口**为界（`windowDays`），而不是「本轮抓到过课的日期」：
 *   - 门店本轮**一天都没抓到课** → 整个不动（接口抽风/平台停摆时不能清库）
 *   - 门店本轮**至少有一天**抓到课 → 说明该门店的接口是活的，于是窗口内
 *     「空返回的那几天」也算明确信号，照常清理
 *
 * ⚠ 为什么第二档必须存在：菲体云、嘉禾这类平台是「成块发布」的 —— 课表提前一周
 *   才排出来，今天看未来三天可能就是空的。老逻辑只清「抓到课的门店+日期」，于是
 *   上游把已发布的课撤回去（重新排课）时，我们库里那几天的旧课**永远不会被清**
 *   （1758DanceStudio 亮马店、澜·锦序都是这么留下滞留课的）。
 *
 * 其余保护不变：
 *   - 用户手录的课（ownerId 非空）→ 永远不碰
 *   - 有预约 / 有提醒的课 → 保留（删了会连带删掉用户自己的记录）
 *   - 骤减保护：只在该天**本轮确实抓到过课**时才判 —— 「库里 8 节以上、本轮只活下
 *     不足三成」疑似平台改版/分页没翻完，跳过并告警。该天完全空返回属于明确信号，
 *     不走这条保护（否则「整组空返回」永远清不掉，这正是本次要修的病）。
 *
 * @param {Set<string>} seen 本轮抓到的课程指纹
 * @param {Date[]|string[]} [windowDays] 本轮抓取覆盖的日期；不传则退回老行为
 * @returns {Promise<{ pruned: number, groups: number, skippedGroups: string[] }>}
 */
export async function pruneVanished(seen, windowDays) {
  // 应急开关：CRAWL_PRUNE=0 可整体关掉清理（默认开）。
  // 万一某个平台的接口悄悄改了分页/字段，导致抓到的课骤减，不用回滚代码就能先止血。
  if (String(process.env.CRAWL_PRUNE ?? "1") === "0") {
    return { pruned: 0, groups: 0, skippedGroups: ["已通过 CRAWL_PRUNE=0 关闭"] };
  }

  // 门店 → 本轮抓到过课的日期集合
  const hitDaysByStudio = new Map();
  for (const key of seen.keys()) {
    const [sid, day] = key.split("|");
    if (!hitDaysByStudio.has(sid)) hitDaysByStudio.set(sid, new Set());
    hitDaysByStudio.get(sid).add(day);
  }

  // 本轮窗口（日期串）。传了就按窗口清（含「空返回」的天），没传退回老行为。
  const windowList = Array.isArray(windowDays)
    ? windowDays.map((d) =>
        typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10),
      )
    : null;

  let pruned = 0;
  let groups = 0;
  const skippedGroups = [];

  // ⚠ 只遍历「本轮至少抓到过一天课」的门店 —— 一天都没抓到的门店整组不动
  //   （接口抽风/平台停摆时不会把库清空）
  for (const [sid, hitDays] of hitDaysByStudio) {
    const studioId = Number(sid);
    const days = windowList ? [...new Set([...windowList, ...hitDays])] : [...hitDays];
    const dates = days.map((d) => new Date(`${d}T00:00:00Z`));
    const existing = await prisma.schedule.findMany({
      where: { studioId, ownerId: null, scheduleDate: { in: dates } },
      select: { id: true, courseName: true, scheduleDate: true, startTime: true, coachId: true },
    });
    if (!existing.length) continue;

    // 逐天判断，避免某天数据异常连累同店其他日期
    for (const day of days) {
      const date = new Date(`${day}T00:00:00Z`);
      const sameDay = existing.filter(
        (e) => e.scheduleDate.toISOString().slice(0, 10) === day,
      );
      const kept = sameDay.filter((e) =>
        seen.has(fingerprint(studioId, date, e.courseName, e.startTime, e.coachId)),
      );
      const stale = sameDay.filter((e) => !kept.includes(e));
      if (!stale.length) continue;
      // 骤减保护只对「该天本轮确实抓到过课」的天生效 —— 那是「抓到但骤减」，
      // 疑似平台改版/分页没翻完。该天完全空返回是明确信号，不走这条保护，
      // 否则「上游把课撤回去」这种情况永远清不掉。
      if (hitDays.has(day) && sameDay.length >= 8 && kept.length < sameDay.length * 0.3) {
        skippedGroups.push(`${studioId}@${day} 库里${sameDay.length}节仅存活${kept.length}节`);
        continue;
      }

      const res = await prisma.schedule.deleteMany({
        where: {
          id: { in: stale.map((e) => e.id) },
          ownerId: null,
          bookings: { none: {} },
          reminders: { none: {} },
        },
      });
      pruned += res.count;
      groups += 1;
    }
  }

  if (skippedGroups.length) {
    console.warn(
      `[importer] 骤减保护触发，跳过 ${skippedGroups.length} 组清理：${skippedGroups.slice(0, 5).join("；")}`,
    );
  }
  return { pruned, groups, skippedGroups };
}

/**
 * 批量导入
 * @param config 抓取配置（含 studio 引用）
 * @param rows 原始条目，每条需带 _date（Date 类型）；可带 _studioName 覆盖默认 studio
 * @param ensureStudios 只要建店、不排课的门店清单
 * @param {{ windowDays?: (Date|string)[] }} [opts] windowDays = 本轮抓取覆盖的日期，
 *        交给 pruneVanished 判断「窗口内空返回的天」要不要算作上游已撤课
 * @returns {{ studios, created, updated, skipped, total, pruned }} 汇总（多门店时按门店细分）
 */
export async function importSchedules(config, rows, ensureStudios = [], opts = {}) {
  /**
   * 建店用的档案。⚠ address 是**配置顶层**字段，不在 config.studio 里 ——
   * 早期只展开 config.studio（name/city/region），于是配置里那 1100 条真地址
   * 一条都没进库（库里地址覆盖率常年只有 14%），区名和坐标全都抽不出来。
   */
  const baseCoord = sanitizeLatLng(config.lat, config.lng, config.studio?.region);
  const baseRef = {
    ...config.studio,
    ...(config.address ? { address: config.address } : {}),
    ...(baseCoord ? { lat: baseCoord.lat, lng: baseCoord.lng } : {}),
  };

  /**
   * 只要建店、不排课的门店。
   * 有的平台（嘉禾）课表接口只返回「今天有课」的门店，当天没排课的分店
   * 会整个从库里消失 —— 用户翻列表时以为没接入。档案接口能拿到全量门店，
   * 这里先把它们建出来，课为 0 也留一条记录。
   */
  for (const ref of ensureStudios) {
    if (!ref || !ref.name) continue;
    try {
      const coord = sanitizeLatLng(ref.lat, ref.lng, baseRef.region);
      const studioRef = {
        ...baseRef,
        name: ref.name,
        ...(ref.city ? { city: ref.city } : {}),
        // 上游实时拿到的地址比配置里写死的准优先
        ...(ref.address ? { address: ref.address } : {}),
        // 门店电话（魔方约课这类门店清单接口直接给 phone）
        ...(ref.contact ? { contact: ref.contact } : {}),
        ...(coord ? { lat: coord.lat, lng: coord.lng } : {}),
      };
      await findOrCreateStudio(studioRef, {
        bookingMiniAppId: config.http?.appId || config.aiwugong?.host,
      });
    } catch (e) {
      console.warn("[importer] 建店失败:", ref && ref.name, e.message);
    }
  }

  // 按门店分组（http 模式的分店用 _studioName，缺省回落到 config.studio.name）
  const groups = new Map();
  for (const row of rows) {
    const studioName = (row._studioName || "").trim() || config.studio.name;
    if (!groups.has(studioName)) groups.set(studioName, []);
    groups.get(studioName).push(row);
  }

  const created = {};
  const updated = {};
  let skipped = 0;
  /** 本轮抓到过的课程指纹，供 pruneVanished 判断哪些课已经在上游消失 */
  const seen = new Set();

  for (const [studioName, groupRows] of groups) {
    // iWOD / 爱舞功系店铺的约课小程序 appId → Studio.bookingMiniAppId（预约跳转用）
    const extra = {};
    const bookingAppId = config.http?.appId || config.aiwugong?.host;
    if (bookingAppId) extra.bookingMiniAppId = bookingAppId;
    // 多门店配置（如 JustJerk 两个校区各自一个官网页）可在条目级覆盖
    // 城市/官网/平台，优先级高于 config.studio
    const rowOverride = {};
    for (const key of ["_officialUrl", "_platform", "_address", "_city"]) {
      const v = groupRows.find((r) => r[key])?.[key];
      if (v) rowOverride[key] = v;
    }
    const rowCoord = sanitizeLatLng(
      groupRows.find((r) => r._lat != null)?._lat,
      groupRows.find((r) => r._lng != null)?._lng,
      baseRef.region,
    );
    const studioRef = {
      ...baseRef,
      name: studioName,
      ...(rowOverride._officialUrl ? { officialUrl: rowOverride._officialUrl } : {}),
      ...(rowOverride._platform ? { platform: rowOverride._platform } : {}),
      ...(rowOverride._address ? { address: rowOverride._address } : {}),
      // 跨城市连锁（如嘉禾舞社：北京/广州/青岛/天津/邯郸）按门店地址覆盖城市
      ...(rowOverride._city ? { city: rowOverride._city } : {}),
      // 门店级坐标（一只鸟 / 舞空云 / 青橙 / styd 的门店清单直接给 lat,lng）
      ...(rowCoord ? { lat: rowCoord.lat, lng: rowCoord.lng } : {}),
    };
    const studio = await findOrCreateStudio(studioRef, extra);

    // 先把全部原始行映射成库条目（要过 findOrCreateCoach，拿到稳定 coachId），
    // 再统计「同日 + 同名课 + 同时分」在本轮出现了几次 —— 出现 ≥2 次说明
    // 舞室在同一时段开了多个同名班（OG Dance 的「特邀导师」Bala/酸酸同在 18:30），
    // upsertSchedule 必须按教练区分，不能把后一个班顶进前一行的槽位。
    const entries = [];
    for (const row of groupRows) {
      const coach = await findOrCreateCoach(studio.id, row.coach, row._coachAvatar);
      const entry = mapRawToSchedule(row, {
        studioId: studio.id,
        coachId: coach ? coach.id : null,
        date: row._date,
      });
      if (!entry.courseName || !entry.scheduleDate || !entry.startTime || !entry.endTime) {
        skipped += 1;
        continue;
      }
      entries.push(entry);
    }

    const slotKeyOf = (e) =>
      `${e.scheduleDate.toISOString().slice(0, 10)}|${courseKey(e.courseName)}|` +
      `${String(e.startTime.getUTCHours()).padStart(2, "0")}:${String(e.startTime.getUTCMinutes()).padStart(2, "0")}`;
    const slotCount = new Map();
    for (const e of entries) {
      const k = slotKeyOf(e);
      slotCount.set(k, (slotCount.get(k) || 0) + 1);
    }

    for (const entry of entries) {
      seen.add(
        fingerprint(studio.id, entry.scheduleDate, entry.courseName, entry.startTime, entry.coachId),
      );
      const res = await upsertSchedule(entry, { ambiguous: slotCount.get(slotKeyOf(entry)) > 1 });
      if (res.action === "created") created[studioName] = (created[studioName] || 0) + 1;
      else updated[studioName] = (updated[studioName] || 0) + 1;
    }
  }

  // 先按「本轮看到的课」清理幽灵课，再失效时间轴缓存（顺序反了会把旧数据缓存进去）
  const prune = await pruneVanished(seen, opts.windowDays);

  await invalidateTimelineCache();
  return {
    studios: [...groups.keys()],
    created,
    updated,
    skipped,
    pruned: prune.pruned,
    total: rows.length,
  };
}
