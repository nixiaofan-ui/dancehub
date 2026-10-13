/**
 * 抓取对账烟测（lib/reconcile-studios.js + importer 的「见到」打点）。
 *
 * 这个模块会**下线门店并删课**，而且是「自动」跑的（挂在每轮 tick 末尾），
 * 所以每条保护都必须单独钉住：
 *   - 只给「本轮成功抓取、且结果里没有它」的店计数；没跑/跑失败的配置不计数
 *   - 骤减保护：库内 ≥3 家、本轮见到的不足一半 → 整份配置跳过（防一次改版清空平台）
 *   - 手录/补录门店（lastSeenAt 为空）永远免疫
 *   - 有预约 / 有提醒 / 用户手录的课一节都不能删
 *   - 退休可逆：上游把店加回来时 importer 会唤醒它并把计数归零
 *
 *   cd server && /usr/local/bin/node --import ../tools/prisma-stub-hooks.mjs ../tools/smoke-reconcile-studios.mjs
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { reconcileStudios, staleStudios, backfillStudioOwnership } = await import(
  "../server/src/lib/reconcile-studios.js"
);
const { findOrCreateStudio } = await import("../server/src/crawler/importer.js");
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

/** 相对今天的 UTC 午夜 */
const T = (off) => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + off));
};
const at = (off, h, m = 0) => {
  const d = T(off);
  d.setUTCHours(h, m, 0, 0);
  return d;
};
/** 一条课（默认无预约无提醒、非手录） */
const course = (id, studioId, off, name, over = {}) => ({
  id,
  studioId,
  courseName: name,
  scheduleDate: T(off),
  startTime: at(off, 19),
  endTime: at(off, 20),
  coachId: null,
  ownerId: null,
  bookings: [],
  reminders: [],
  ...over,
});

const CID = "gsteps-beijing";
/** 一小时前「见过」的抓取门店（missedRounds 已攒到几轮） */
const studioRow = (id, name, over = {}) => ({
  id,
  name,
  cityId: 1,
  status: true,
  lastSeenAt: new Date(Date.now() - 3600_000),
  lastCrawlConfigId: CID,
  missedRounds: 0,
  ...over,
});
const row = (id) => prisma.studio.findUnique({ where: { id } });
const seen = (names, { at: when = new Date() } = {}) =>
  new Map([[CID, { at: when, studios: names }]]);

// ─── ① 只给「本轮没见到」的店计数 ──────────────────────────────────
__reset();
await prisma.studio.create({ data: studioRow(1, "G-STEPS·A店（上海）") });
await prisma.studio.create({ data: studioRow(2, "G-STEPS·B店（上海）") });
await prisma.studio.create({ data: studioRow(3, "G-STEPS·C店（上海）") });
{
  const r = await reconcileStudios({
    seenByConfig: seen(["G-STEPS·A店（上海）", "G-STEPS·C店（上海）"]),
    log: () => {},
  });
  check("① 检查了 3 家", r.checked, 3);
  check("① 只有 B 店被计数", r.bumped, 1);
  check("① B 店 missedRounds=1", (await row(2)).missedRounds, 1);
  check("① A 店仍为 0", (await row(1)).missedRounds, 0);
  check("① 还没到阈值，不退休", r.retired, 0);
}

// ─── ② 连续 3 轮没出现 → 退休（下线 + 清未来课，留过去课与有预约的课）──
__reset();
await prisma.studio.create({ data: studioRow(2, "G-STEPS·B店（上海）") });
await prisma.schedule.create({ data: course(101, 2, 1, "Hiphop") }); // 未来 → 清
await prisma.schedule.create({ data: course(102, 2, 5, "Jazz") }); // 未来 → 清
await prisma.schedule.create({ data: course(103, 2, -3, "Waacking") }); // 过去 → 留
await prisma.schedule.create({
  data: course(104, 2, 2, "已约的课", { bookings: [{ id: 900 }] }),
});
{
  const r1 = await reconcileStudios({ seenByConfig: seen([]), log: () => {} });
  check("② 第 1 轮：计数 1", r1.bumped, 1);
  check("② 第 1 轮：没退休", r1.retired, 0);
  const r2 = await reconcileStudios({ seenByConfig: seen([]), log: () => {} });
  check("② 第 2 轮：计数 2", r2.bumped, 1);
  check("② 第 2 轮：没退休", r2.retired, 0);
  const r3 = await reconcileStudios({ seenByConfig: seen([]), log: () => {} });
  check("② 第 3 轮：退休 1 家", r3.retired, 1);
  check("② 第 3 轮：清掉 2 节没人管的未来课", r3.pruned, 2);
  check("② 门店已下线", (await row(2)).status, false);
  const left = (await prisma.schedule.findMany()).map((s) => s.id).sort();
  check("② 过去课 + 有预约的课都留着", left, [103, 104]);
}

// ─── ③ 幂等：重跑不能再报改动 ──────────────────────────────────────
{
  const r = await reconcileStudios({ seenByConfig: seen([]), log: () => {} });
  check("③ 重跑 retired 0", r.retired, 0);
  check("③ 重跑 pruned 0", r.pruned, 0);
}

// ─── ④ 骤减保护：库内 4 家只见到 1 家 → 整份配置跳过 ───────────────
__reset();
for (const [i, n] of ["A", "B", "C", "D"].entries()) {
  await prisma.studio.create({ data: studioRow(10 + i, `G-STEPS·${n}店（上海）`) });
}
{
  const r = await reconcileStudios({
    seenByConfig: seen(["G-STEPS·A店（上海）"]),
    log: () => {},
  });
  check("④ 跳过 1 份配置", r.skipped, 1);
  check("④ 一家都没计数", r.bumped, 0);
  check("④ 计数全是 0", (await prisma.studio.findMany()).every((s) => s.missedRounds === 0), true);
}

// ─── ⑤ 单店配置不受骤减保护影响（G-STEPS 湖滨道店就是这种）────────
__reset();
await prisma.studio.create({ data: studioRow(20, "G-STEPS·新天地湖滨道店（上海）") });
{
  const r = await reconcileStudios({ seenByConfig: seen([]), log: () => {} });
  check("⑤ 单店配置：不跳过", r.skipped, 0);
  check("⑤ 单店配置：计数 1", r.bumped, 1);
}

// ─── ⑥ 手录店（lastSeenAt 为空）永远免疫 ───────────────────────────
__reset();
await prisma.studio.create({
  data: { id: 30, name: "我自己录的舞室", cityId: 1, status: true, missedRounds: 99 },
});
{
  const r = await reconcileStudios({ seenByConfig: seen([]), log: () => {} });
  check("⑥ 手录店不被计数", r.bumped, 0);
  check("⑥ 手录店不被退休", r.retired, 0);
  check("⑥ 手录店仍可见", (await row(30)).status, true);
  check("⑥ 诊断列表里也没有它", (await staleStudios()).length, 0);
}

// ─── ⑦ dryRun：只看不动 ────────────────────────────────────────────
__reset();
await prisma.studio.create({ data: studioRow(40, "G-STEPS·E店（上海）", { missedRounds: 2 }) });
{
  const r = await reconcileStudios({ seenByConfig: seen([]), dryRun: true, log: () => {} });
  check("⑦ 预演说会计数 1 家", r.bumped, 1);
  check("⑦ 预演列出 1 个候选", r.candidates.length, 1);
  check("⑦ 候选名字对", r.candidates[0].name, "G-STEPS·E店（上海）");
  check("⑦ 库里没动", (await row(40)).missedRounds, 2);
}

// ─── ⑧ 没有本轮抓取结果时，仍能清退已达阈值的店 ────────────────────
__reset();
await prisma.studio.create({ data: studioRow(50, "G-STEPS·F店（上海）", { missedRounds: 3 }) });
{
  const r = await reconcileStudios({ log: () => {} });
  check("⑧ 无本轮结果也能清退", r.retired, 1);
  check("⑧ F 店已下线", (await row(50)).status, false);
}

// ─── ⑨ importer 打点：又见到它 → 计数归零（这是复活的唯一入口）─────
__reset();
await prisma.city.create({ data: { id: 1, name: "上海", region: "CN" } });
await prisma.studio.create({
  data: studioRow(60, "G-STEPS·G店（上海）", { status: false, missedRounds: 3 }),
});
{
  const out = await findOrCreateStudio(
    { name: "G-STEPS·G店（上海）", city: "上海", region: "CN" },
    { crawlConfigId: CID },
  );
  check("⑨ 门店被唤醒", (await row(60)).status, true);
  check("⑨ 计数归零", (await row(60)).missedRounds, 0);
  check("⑨ 归属写成这份配置", out.lastCrawlConfigId, CID);
  check("⑨ lastSeenAt 已写入", (await row(60)).lastSeenAt instanceof Date, true);
}

// ─── ⑩ 非抓取调用（不传 crawlConfigId）绝不打点 ────────────────────
__reset();
await prisma.studio.create({
  data: { id: 70, name: "手录的店", cityId: 1, status: true, missedRounds: 0 },
});
{
  await findOrCreateStudio({ name: "手录的店", city: "上海", region: "CN" });
  check("⑩ 没被打上 lastSeenAt", (await row(70)).lastSeenAt ?? null, null);
  check("⑩ 没被打上归属", (await row(70)).lastCrawlConfigId ?? null, null);
}

// ─── ⑪ 改名复用（库里旧名 ≠ 本轮新名）不算「没见到」 ───────────────
__reset();
// 真实链路下 importer 已按归一化同名复用了老记录、并打点过 lastSeenAt（= 刚刚），
// 这里把那个状态摆出来：只有名字对不上，时间是新的。
await prisma.studio.create({
  data: studioRow(80, "G-STEPS·新天地店（上海）", { lastSeenAt: new Date() }),
});
{
  // 本轮 report 给的是半角括号的新写法，importer 按归一化同名复用了老记录
  const r = await reconcileStudios({
    seenByConfig: seen(["G-STEPS·新天地店(上海)"]),
    log: () => {},
  });
  check("⑪ 名字对不上：不计数（本轮确实抓到了它）", r.bumped, 0);
}

// ─── ⑫ 归属回填：只给 WECHAT 抓取店补归属，手录 / 匹配不到的店保持免疫 ──
__reset();
await prisma.studio.create({
  data: { id: 90, name: "G-STEPS", cityId: 1, status: true, platform: "WECHAT" },
});
await prisma.studio.create({
  data: { id: 91, name: "G-STEPS·五道口店（北京）", cityId: 1, status: true, platform: "WECHAT" },
});
// 匹配不到任何配置的自营店 → 永远不参与对账
await prisma.studio.create({
  data: { id: 92, name: "某自营舞室", cityId: 1, status: true, platform: "WECHAT" },
});
// 用户手录店凑巧也以品牌名开头，但 platform=OTHER → 必须完全不动
await prisma.studio.create({
  data: { id: 93, name: "G-STEPS·我自己录的（北京）", cityId: 1, status: true, platform: "OTHER" },
});
{
  const r = await backfillStudioOwnership({ log: () => {} });
  check("⑫ 只扫 WECHAT 的 3 家", r.scanned, 3);
  check("⑫ 回填 2 家", r.filled, 2);
  check("⑫ 匹配不到的不打标", (await row(92)).lastCrawlConfigId ?? null, null);
  check("⑫ 手录店（OTHER）不碰", (await row(93)).lastCrawlConfigId ?? null, null);
  check("⑫ 归属非空（具体哪份由同城优先规则定，不钉死）", typeof (await row(90)).lastCrawlConfigId, "string");
  check("⑫ 基线时刻已写入", (await row(90)).lastSeenAt instanceof Date, true);
  const again = await backfillStudioOwnership({ log: () => {} });
  check("⑫ 幂等：重跑不再回填", again.filled, 0);
  check("⑫ 幂等：重跑只扫到剩余 1 家", again.scanned, 1);
}

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);