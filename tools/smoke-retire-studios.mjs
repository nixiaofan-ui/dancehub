/**
 * 停抓门店退休烟测（lib/retire-studios.js）。
 *
 * 这个模块会**删数据**，所以每条保护都得单独钉住：
 *   - 只认 `retired: true`，`enabled: false`（临时停抓）绝不能顺手把店下线
 *   - 未来课清掉，**过去的课留着**（历史课前端不显示，删了丢审计线索）
 *   - 有预约 / 有提醒的课**一节都不能删**（Reminder 是外键，删课会连带删用户记录）
 *   - 幂等：重启会再跑一次，重跑必须 retired=0
 *
 *   cd server && /usr/local/bin/node --import ../tools/prisma-stub-hooks.mjs ../tools/smoke-retire-studios.mjs
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { retireStudios } = await import("../server/src/lib/retire-studios.js");
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

const CONFIGS = [
  { id: "fityun-11057041", retired: true, enabled: false, studio: { name: "澜·锦序", city: "银川" } },
  { id: "paused-only", enabled: false, studio: { name: "只是暂停了", city: "北京" } },
];

// ─── ① 退休店：下线 + 清未来课、留过去课 ─────────────────────────────
__reset();
await prisma.studio.create({ data: { id: 1093, name: "澜·锦序", cityId: 1, status: true } });
await prisma.schedule.create({ data: course(1, 1093, 1, "古典舞") }); // 未来 → 清
await prisma.schedule.create({ data: course(2, 1093, 5, "中国舞") }); // 未来 → 清
await prisma.schedule.create({ data: course(3, 1093, -3, "古典舞") }); // 过去 → 留
{
  const r = await retireStudios({ configs: CONFIGS });
  check("下线 1 家", r.retired, 1);
  check("清掉 2 节未来课", r.pruned, 2);
  const rows = await prisma.schedule.findMany();
  check("只剩过去那节", rows.map((s) => s.id), [3]);
  check("门店已不可见", (await prisma.studio.findMany())[0].status, false);
}

// ─── ② 幂等：容器重跑一遍不能再报改动 ───────────────────────────────
{
  const r = await retireStudios({ configs: CONFIGS });
  check("重跑 retired 0", r.retired, 0);
  check("重跑 pruned 0", r.pruned, 0);
}

// ─── ③ 有预约 / 有提醒的课绝不能删 ─────────────────────────────────
__reset();
await prisma.studio.create({ data: { id: 1093, name: "澜·锦序", cityId: 1, status: true } });
await prisma.schedule.create({ data: course(11, 1093, 1, "已约的课", { bookings: [{ id: 900 }] }) });
await prisma.schedule.create({ data: course(12, 1093, 1, "设了提醒的课", { reminders: [{ id: 901 }] }) });
await prisma.schedule.create({ data: course(13, 1093, 1, "没人管的课") });
{
  const r = await retireStudios({ configs: CONFIGS });
  check("只清掉 1 节（没人管的）", r.pruned, 1);
  const left = (await prisma.schedule.findMany()).map((s) => s.id).sort();
  check("有预约/有提醒的都留着", left, [11, 12]);
  check("店还是下线了", (await prisma.studio.findMany())[0].status, false);
}

// ─── ④ 手录的课（ownerId 非空）不碰 ────────────────────────────────
__reset();
await prisma.studio.create({ data: { id: 1093, name: "澜·锦序", cityId: 1, status: true } });
await prisma.schedule.create({ data: course(21, 1093, 1, "手录的课", { ownerId: 7 }) });
{
  const r = await retireStudios({ configs: CONFIGS });
  check("手录课不被删", r.pruned, 0);
  check("手录课还在", (await prisma.schedule.findMany()).length, 1);
}

// ─── ⑤ enabled:false 但没 retired → 一动不动 ────────────────────────
__reset();
await prisma.studio.create({ data: { id: 77, name: "只是暂停了", cityId: 14, status: true } });
await prisma.schedule.create({ data: course(31, 77, 1, "Kpop") });
{
  const r = await retireStudios({ configs: CONFIGS });
  check("暂停店：retired 0", r.retired, 0);
  check("暂停店：pruned 0", r.pruned, 0);
  check("暂停店：仍然可见", (await prisma.studio.findMany())[0].status, true);
  check("暂停店：课还在", (await prisma.schedule.findMany()).length, 1);
}

// ─── ⑥ 库里没这家店 → 记 missing，不报错 ───────────────────────────
__reset();
{
  const r = await retireStudios({ configs: CONFIGS });
  // 只有「澜·锦序」带 retired:true，所以 targets=1、missing=1
  check("没有对应门店：targets 1", r.targets, 1);
  check("没有对应门店：missing 1", r.missing, 1);
  check("没有对应门店：retired 0", r.retired, 0);
}

// ─── ⑦ 同名多条（改名遗留的空壳店）一并下线 ────────────────────────
__reset();
await prisma.studio.create({ data: { id: 1093, name: "澜·锦序", cityId: 1, status: true } });
await prisma.studio.create({ data: { id: 1500, name: "澜·锦序", cityId: 14, status: true } });
{
  const r = await retireStudios({ configs: CONFIGS });
  check("同名两条都下线", r.retired, 2);
  check("库里没有可见的澜·锦序", (await prisma.studio.findMany()).filter((s) => s.status).length, 0);
}

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
