/**
 * 幽灵课清理（pruneVanished）的窗口感知烟测。
 *
 * 老逻辑只清「本轮**抓到过课**的门店+日期」——上游把某天的课撤回去（重新排课）
 * 或整块还没发布时，那天压根不进清理范围，旧课就永久滞留。2026-10-09 实测：
 * 澜·锦序上游 14 天全空、库里 10-01~10-07 的课一直在。
 *
 * 改写后要同时满足两条相反的诉求，这里逐条钉住：
 *   - 上游**整块**空返回（门店本轮一天都没抓到课）→ 一个字都不能清（防抽风误删）
 *   - 门店本轮**有别的天正常抓到课** → 说明接口是活的，窗口内空返回的天算撤课，清
 *   - 骤减保护只对「该天本轮确实抓到过课」的天生效（那是「抓到但骤减」）
 *   - 不传 windowDays 时退回老行为（热刷新走这条路，不能扩大清理面）
 *
 *   cd server && /usr/local/bin/node --import ../tools/prisma-stub-hooks.mjs ../tools/smoke-prune-window.mjs
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { pruneVanished } = await import("../server/src/crawler/importer.js");
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

const T = (off) => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + off));
};
const S = (off) => T(off).toISOString().slice(0, 10);
const at = (off, h, m = 0) => {
  const d = T(off);
  d.setUTCHours(h, m, 0, 0);
  return d;
};
/** 与 importer 内部 fingerprint 同格式 */
const fp = (sid, off, name, hhmm, coachId = null) =>
  `${sid}|${S(off)}|${name}|${hhmm}|${coachId ?? "-"}`;

const course = (id, studioId, off, name, h, over = {}) => ({
  id,
  studioId,
  courseName: name,
  scheduleDate: T(off),
  startTime: at(off, h),
  endTime: at(off, h + 1),
  coachId: null,
  ownerId: null,
  bookings: [],
  reminders: [],
  ...over,
});

const WINDOW = [T(0), T(1), T(2)];

// ─── ① 窗口内的「空返回天」照样清，抓到的天保留 ─────────────────────
__reset();
await prisma.schedule.create({ data: course(1, 1, 1, "Kpop", 19) });
await prisma.schedule.create({ data: course(2, 1, 2, "已经被撤掉的旧课", 19) });
{
  const seen = new Set([fp(1, 1, "Kpop", "19:00")]);
  const r = await pruneVanished(seen, WINDOW);
  check("清了 1 节", r.pruned, 1);
  check("留下的是抓到的那节", (await prisma.schedule.findMany()).map((s) => s.id), [1]);
}

// ─── ② 门店本轮一天都没抓到课 → 一个字都不清 ────────────────────────
__reset();
await prisma.schedule.create({ data: course(1, 1, 1, "课A", 19) });
await prisma.schedule.create({ data: course(2, 1, 2, "课B", 20) });
{
  const r = await pruneVanished(new Set(), WINDOW);
  check("全空：pruned 0", r.pruned, 0);
  check("全空：两节都还在", (await prisma.schedule.findMany()).length, 2);
}

// ─── ③ 骤减保护：该天有抓到课但骤减 → 跳过并告警 ────────────────────
__reset();
for (let i = 0; i < 10; i++) {
  await prisma.schedule.create({ data: course(100 + i, 1, 1, `课${i}`, 19) });
}
{
  // 只活着 1 节 → 10 节里活了 1 节（<30%）→ 典型的分页没翻完
  const seen = new Set([fp(1, 1, "课0", "19:00")]);
  const r = await pruneVanished(seen, WINDOW);
  check("骤减保护：pruned 0", r.pruned, 0);
  check("骤减保护：报 1 组", r.skippedGroups.length, 1);
  check("骤减保护：10 节都还在", (await prisma.schedule.findMany()).length, 10);
}

// ─── ④ 不传 windowDays → 老行为（热刷新走这条，不许扩大清理面） ───────
__reset();
await prisma.schedule.create({ data: course(1, 1, 1, "Kpop", 19) });
await prisma.schedule.create({ data: course(2, 1, 2, "窗口外的旧课", 19) });
{
  const seen = new Set([fp(1, 1, "Kpop", "19:00")]);
  const r = await pruneVanished(seen);
  check("不传窗口：pruned 0", r.pruned, 0);
  check("不传窗口：两节都还在", (await prisma.schedule.findMany()).length, 2);
}

// ─── ⑤ 空返回的天里，有预约 / 有提醒的课也不清 ──────────────────────
__reset();
await prisma.schedule.create({ data: course(1, 1, 1, "Kpop", 19) });
await prisma.schedule.create({ data: course(2, 1, 2, "被约了", 19, { bookings: [{ id: 1 }] }) });
await prisma.schedule.create({ data: course(3, 1, 2, "设了提醒", 20, { reminders: [{ id: 2 }] }) });
await prisma.schedule.create({ data: course(4, 1, 2, "没人管", 21) });
{
  const seen = new Set([fp(1, 1, "Kpop", "19:00")]);
  const r = await pruneVanished(seen, WINDOW);
  check("只清掉没人管的那节", r.pruned, 1);
  check(
    "有预约/有提醒/抓到的都留着",
    (await prisma.schedule.findMany()).map((s) => s.id).sort(),
    [1, 2, 3],
  );
}

// ─── ⑥ 手录课（ownerId 非空）永远不碰 ──────────────────────────────
__reset();
await prisma.schedule.create({ data: course(1, 1, 1, "Kpop", 19) });
await prisma.schedule.create({ data: course(2, 1, 2, "手录的", 19, { ownerId: 7 }) });
{
  const seen = new Set([fp(1, 1, "Kpop", "19:00")]);
  const r = await pruneVanished(seen, WINDOW);
  check("手录课不被清", r.pruned, 0);
  check("两节都还在", (await prisma.schedule.findMany()).length, 2);
}

// ─── ⑦ 多门店隔离：只有活着的门店被清，全空的门店不受连累 ────────────
__reset();
await prisma.schedule.create({ data: course(1, 1, 1, "A店有课", 19) });
await prisma.schedule.create({ data: course(2, 1, 2, "A店被撤的课", 19) });
await prisma.schedule.create({ data: course(3, 2, 2, "B店全空不该动", 19) });
{
  const seen = new Set([fp(1, 1, "A店有课", "19:00")]);
  const r = await pruneVanished(seen, WINDOW);
  check("只清 A 店那节", r.pruned, 1);
  const ids = (await prisma.schedule.findMany()).map((s) => s.id).sort();
  check("B 店的课原样保留", ids, [1, 3]);
}

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
