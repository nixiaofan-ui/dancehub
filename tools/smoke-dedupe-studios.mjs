/**
 * 重复门店归并烟测（lib/dedupe-studios.js）。
 *
 * 这个模块会**隐藏门店 + 删课**，所以每条边界都得单独钉住。2026-10-13 扩展了
 * 「无 appId 门店」这一类（原来查询写死 `bookingMiniAppId: { not: null }`，
 * 导致 gsteps/jiahe 这类不走小程序抓取的门店永远躲过归并 —— 云端 G-STEPS
 * 「上海新天地店」就是这么积出 3 条的）。
 *
 * 要钉住的：
 *   - A 类（有 appId）：同城 + 同 appId + 归一化同名 → 合并（回归）
 *   - B 类（无 appId）：同城 + 同 platform + 归一化同名 + 至少一方是启用配置的目标/分店 → 合并
 *   - B 类**不满足目标名条件** → 绝不合并（保守，宁可漏合并）
 *   - 手录店（platform=OTHER）无论几条同名 → 不碰
 *   - 不同城 → 不合并
 *   - 保留规则：配置目标 > 关注多 > 最近有课更新 > id 小
 *   - 有预约/提醒/用户手录的课**一节都不能删**
 *   - 幂等：重跑必须 groups=0
 *
 *   cd server && /usr/local/bin/node ../tools/smoke-dedupe-studios.mjs
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { dedupeStudios, canonStudioName } = await import(
  "../server/src/lib/dedupe-studios.js"
);
const { prisma, __reset } = await import(
  new URL("./testing/fake-prisma-stub.mjs", import.meta.url)
);

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`,
  );
}

const day = (off) => {
  const n = new Date();
  const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + off));
  return d;
};

/** 一节课（默认无预约无提醒、非手录） */
const course = (id, studioId, off, over = {}) => ({
  id,
  studioId,
  courseName: "基础Jazz",
  scheduleDate: day(off),
  startTime: day(off),
  endTime: day(off),
  coachId: null,
  ownerId: null,
  bookings: [],
  reminders: [],
  updatedAt: day(off),
  ...over,
});

/** 一家门店 */
const studio = (id, name, cityId, over = {}) => ({
  id,
  name,
  cityId,
  status: true,
  address: null,
  bookingMiniAppId: null,
  platform: "WECHAT",
  _count: { follows: 0 },
  ...over,
});

/** 每个用例前重置：数据 + 只有 dedupe 关心的几张表 */
async function seed() {
  __reset();
  await prisma.studio.create({
    data: studio(101, "D-DAY 舞蹈（秦淮）", 19, { bookingMiniAppId: "wxdd0001" }),
  });
  await prisma.studio.create({
    data: studio(102, "D-DAY 舞蹈（市秦淮）", 19, { bookingMiniAppId: "wxdd0001" }),
  });

  // B 类主力：G-STEPS 上海新天地店三条同名（真实事故形态）
  // 关注数刻意做成「202 最多」—— 用来钉住「用户资产优先于活跃度」这条排序规则：
  // 201 课最多也最新，但 202 有 2 个关注，keeper 必须是 202。
  for (const id of [201, 202, 203]) {
    await prisma.studio.create({
      data: studio(id, "G-STEPS·上海新天地店（上海）", 1, {
        _count: { follows: id === 202 ? 2 : id === 203 ? 1 : 0 },
      }),
    });
  }

  // B 类保守闸门：两条同名，但跟任何启用配置都无关
  await prisma.studio.create({ data: studio(301, "某某舞蹈（总店）", 14) });
  await prisma.studio.create({ data: studio(302, "某某舞蹈（总店）", 14) });

  // 手录店（补录建店写死 platform=OTHER）：两条同名也不许碰
  await prisma.studio.create({
    data: studio(401, "我的私教工作室", 14, { platform: "OTHER" }),
  });
  await prisma.studio.create({
    data: studio(402, "我的私教工作室", 14, { platform: "OTHER" }),
  });

  // 同名但不同城 → 不合并（城市是判重的一部分）
  await prisma.studio.create({
    data: studio(501, "G-STEPS·新天地湖滨道店（上海）", 1),
  });
  await prisma.studio.create({
    data: studio(502, "G-STEPS·新天地湖滨道店（北京）", 14),
  });

  // ⛔ 海外非中日韩店名：三家**完全不同的韩文店**。
  //   老归一化正则 [0-9A-Za-z\u4e00-\u9fa5] 会把它们全部过滤成空串 →
  //   同城同 platform 直接碰撞成一组 → 误合并两家真店。这条用例只认「归一化后互不相同」。
  await prisma.studio.create({
    data: studio(601, "알티댄스 시흥사거리점", 200),
  });
  await prisma.studio.create({
    data: studio(602, "리바이브스튜디오", 200),
  });
  await prisma.studio.create({
    data: studio(603, "던 댄스 스튜디오", 200),
  });

  // ⛔ 归一化后为空的门店（纯符号）：空串之间恒等，必须靠「空名不进组」这道闸挡住。
  //   用有 appId 的写法来测 —— 否则会被「目标名门槛」先拦下，测不到这道保险。
  await prisma.studio.create({
    data: studio(701, "!!!", 14, { bookingMiniAppId: "wxkid0001" }),
  });
  await prisma.studio.create({
    data: studio(702, "???", 14, { bookingMiniAppId: "wxkid0001" }),
  });

  // 课：101 两节（最新），102 一节（三天前 → 该店最旧，keeper 判给 101）
  await prisma.schedule.create({
    data: course(1001, 101, -1, { updatedAt: day(1) }),
  });
  await prisma.schedule.create({
    data: course(1002, 101, 1, { updatedAt: day(1) }),
  });
  await prisma.schedule.create({
    data: course(1003, 102, 1, { updatedAt: day(-3) }),
  });

  // 201 = 课最多最新，但**零关注**（故意不选它，验证关注优先于活跃度）
  await prisma.schedule.create({
    data: course(2001, 201, -1, { bookings: [{ id: 1, userId: 7 }], updatedAt: day(2) }),
  });
  await prisma.schedule.create({ data: course(2002, 201, 1, { updatedAt: day(2) }) });
  await prisma.schedule.create({ data: course(2003, 201, 2, { updatedAt: day(2) }) });
  // 202 = 保留方：一节有人预约（谁都不许删）、一节空的
  await prisma.schedule.create({
    data: course(2004, 202, -2, { bookings: [{ id: 2, userId: 8 }], updatedAt: day(1) }),
  });
  await prisma.schedule.create({ data: course(2005, 202, -2, { updatedAt: day(1) }) });
  // 203 = 孤儿：只有一节空的
  await prisma.schedule.create({ data: course(2006, 203, -3, { updatedAt: day(-2) }) });

  // 203 上有个用户的关注 → 必须迁到保留方 202（用没被占用的 userId）
  await prisma.follow.create({ data: { id: 900, userId: 9, studioId: 203 } });
}

const TARGETS = new Set(["G-STEPS", "D-DAY 舞蹈", "알티댄스"]);

console.log("=== 第零轮：归一化本身 ===");
check(
  "「（市秦淮）」的半截市名被吃掉",
  canonStudioName("D-DAY 舞蹈（市秦淮）"),
  "dday舞蹈秦淮",
);
check(
  "「（市秦淮）」与「（秦淮）」归一化后必须相等 —— 这正是这条归一化存在的意义",
  canonStudioName("D-DAY 舞蹈（市秦淮）") === canonStudioName("D-DAY 舞蹈（秦淮）"),
  true,
);
check(
  "⛔ 韩文店名必须保留，不能塌成空串",
  canonStudioName("알티댄스 시흥사거리점"),
  "알티댄스시흥사거리점",
);
check("⛔ 纯符号店名归一化就是空串（靠调用方跳过）", canonStudioName("!!!") + canonStudioName("???"), "");

console.log("\n=== 第一轮：dryRun（只报不写） ===");
await seed();
let res = await dedupeStudios({ targetNames: TARGETS, dryRun: true });
check("dryRun 报出 2 组（D-DAY + G-STEPS 新天地）", res.groups, 2);
check("dryRun 不动数据：门店仍 16 条", await prisma.studio.count(), 16);
check("dryRun 不删课：课仍 9 节", await prisma.schedule.count(), 9);

console.log("\n=== 第二轮：真跑 ===");
res = await dedupeStudios({ targetNames: TARGETS });
check("合并 2 组", res.groups, 2);
check("隐藏 3 条（D-DAY 一条 + G-STEPS 两条）", res.hidden, 3);
check("迁移关注 1 条", res.movedFollows, 1);
check("清掉 4 节无预约的孤儿课", res.deletedSchedules, 4);

const alive = async (id) => (await prisma.studio.findUnique({ where: { id } }))?.status;
check("#101 D-DAY（秦淮）保留可见", await alive(101), true);
check("#102 D-DAY（市秦淮）被隐藏", await alive(102), false);
check(
  "⛔ 保留方看**关注数**不看活跃度：#202（2 关注）留下",
  await alive(202),
  true,
);
check("⛔ 课最多也最新的 #201 反而是孤儿 → 被隐藏", await alive(201), false);
check("#203 被隐藏", await alive(203), false);

check("⛔ 两条与配置无关的同名店**不合并**（301 仍可见）", await alive(301), true);
check("⛔ 同上（302 仍可见）", await alive(302), true);
check("⛔ 手录店 401 仍可见", await alive(401), true);
check("⛔ 手录店 402 仍可见", await alive(402), true);
check("⛔ 同名不同城：501（上海）仍可见", await alive(501), true);
check("⛔ 同名不同城：502（北京）仍可见", await alive(502), true);
check(
  "⛔⛔ 三家**不同**韩文店名绝不能互相合并（老正则会把它们归一化成同一个空串）",
  [await alive(601), await alive(602), await alive(603)],
  [true, true, true],
);
check(
  "⛔ 归一化后为空的门店不得互相碰撞（701/702）",
  [await alive(701), await alive(702)],
  [true, true],
);

check(
  "保留方的课一节没动（2004 有预约）",
  !!(await prisma.schedule.findUnique({ where: { id: 2004 } })),
  true,
);
check(
  "保留方无预约的课也不动（2005）",
  !!(await prisma.schedule.findUnique({ where: { id: 2005 } })),
  true,
);
check(
  "⛔ 孤儿店上**有预约**的课必须保住（2001）",
  !!(await prisma.schedule.findUnique({ where: { id: 2001 } })),
  true,
);
check(
  "孤儿店上无预约的课被清（2002）",
  !!(await prisma.schedule.findUnique({ where: { id: 2002 } })),
  false,
);
check(
  "孤儿店上无预约的课被清（2006）",
  !!(await prisma.schedule.findUnique({ where: { id: 2006 } })),
  false,
);
check(
  "D-DAY 孤儿店的课已清（1003）",
  !!(await prisma.schedule.findUnique({ where: { id: 1003 } })),
  false,
);

check(
  "关注已迁到保留方 #202",
  (await prisma.follow.findMany()).map((f) => f.studioId),
  [202],
);

console.log("\n=== 第三轮：幂等 ===");
res = await dedupeStudios({ targetNames: TARGETS });
check("重跑 groups=0（无重复可合）", res.groups, 0);
check("重跑 hidden=0", res.hidden, 0);
check("重跑不再删课", res.deletedSchedules, 0);

console.log("\n=== 第四轮：不给 targetNames ===");
await seed();
res = await dedupeStudios({});
check("无 targetNames 时只剩 A 类那组（B 类无依据 → 不合并）", res.groups, 1);
check(
  "G-STEPS 三条在有 targetNames 的调用里才合，这里必须原样可见",
  [await alive(201), await alive(202), await alive(203)],
  [true, true, true],
);

console.log(
  failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过",
);
process.exit(failed ? 1 : 0);
