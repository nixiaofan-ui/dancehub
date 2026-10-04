/**
 * 同名同时刻双班不丢课 —— importer 匹配键的烟测。
 *
 * 2026-10-04 用户反馈：重庆 OG Dance 舞室小程序里 18:30 有两节「特邀导师」
 * （Bala + 酸酸，各占一个教室、各自名额），DanceHub 只剩酸酸一节，Bala 凭空消失。
 * 根因：upsertSchedule / pruneVanished / dedupe 的匹配键都是
 * 「店 + 日 + 课名 + 开始时分」，不含教练 —— 同名同时刻的两个班先后写进同一行，
 * 后写的把先写的顶掉。
 *
 * 修后的口径：
 *   - 优先认同教练的行；
 *   - 没有同教练行 + 本轮该时段只有一个同名班 → 「换老师」合并进原行（保 id）；
 *   - 没有同教练行 + 本轮该时段有多个同名班（ambiguous）→ 新建，不顶别人。
 *
 *   cd server && /usr/local/bin/node --import ../tools/prisma-stub-hooks.mjs ../tools/smoke-import-coach-collision.mjs
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { upsertSchedule } = await import("../server/src/crawler/importer.js");
const { prisma, __reset } = await import(new URL("./testing/fake-prisma-stub.mjs", import.meta.url));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`);
}

const DAY = new Date("2026-10-04T00:00:00Z");
const T1830 = new Date("1970-01-01T10:30:00Z"); // UTC 10:30 = 北京 18:30
const T2000 = new Date("1970-01-01T12:00:00Z");

function entry(over = {}) {
  return {
    studioId: 1946,
    courseName: "特邀导师",
    difficulty: "ALL_LEVELS",
    scheduleDate: DAY,
    startTime: T1830,
    endTime: T2000,
    capacity: "50",
    bookedNum: 14,
    remark: null,
    coachId: 102, // 默认酸酸
    ownerId: null,
    ...over,
  };
}

// ─── 场景 1：同名同刻双班首轮入库（OG Dance 实况） ─────────────────────────
__reset();
{
  const bala = entry({ coachId: 101, bookedNum: 19, capacity: "60" });
  const suan = entry({ coachId: 102, bookedNum: 14, capacity: "50" });

  const r1 = await upsertSchedule(bala, { ambiguous: true });
  const r2 = await upsertSchedule(suan, { ambiguous: true });
  check("双班首轮：两节都 create", [r1.action, r2.action], ["created", "created"]);
  check("双班首轮：id 不同", r1.id !== r2.id, true);
  check("双班首轮：库里 2 条", prisma.schedule.findMany && (await prisma.schedule.findMany()).length, 2);
}

// ─── 场景 2：下一轮重放，幂等（不新增、各自更新） ────────────────────────────
{
  const rows = await prisma.schedule.findMany();
  const balaId = rows.find((r) => r.coachId === 101).id;
  const suanId = rows.find((r) => r.coachId === 102).id;

  const r1 = await upsertSchedule(entry({ coachId: 101, bookedNum: 25, capacity: "60" }), { ambiguous: true });
  const r2 = await upsertSchedule(entry({ coachId: 102, bookedNum: 14, capacity: "50" }), { ambiguous: true });
  check("重放：各自 updated", [r1.action, r2.action], ["updated", "updated"]);
  check("重放：id 稳定（预约/提醒不连坐）", [r1.id, r2.id], [balaId, suanId]);
  check("重放：仍是 2 条", (await prisma.schedule.findMany()).length, 2);
  check("重放：bookedNum 已刷新", rows.find((r) => r.id === balaId).bookedNum, 25);
}

// ─── 场景 3：单班换老师 → 合并进原行（保 id，老行为保留） ─────────────────────
__reset();
{
  const r1 = await upsertSchedule(entry({ courseName: "Jazz入门", coachId: 101 }));
  const r2 = await upsertSchedule(entry({ courseName: "Jazz入门", coachId: 201 }));
  check("换老师：updated 而不是 create", r2.action, "updated");
  check("换老师：id 不变", r2.id, r1.id);
  check("换老师：库里 1 条", (await prisma.schedule.findMany()).length, 1);
  check("换老师：教练已换", (await prisma.schedule.findMany())[0].coachId, 201);
}

// ─── 场景 4：ambiguous 且库里只有别人教练的行 → 新建，不顶掉 ─────────────────
__reset();
{
  await upsertSchedule(entry({ coachId: 102 })); // 库里已有酸酸（历史轮）
  const r = await upsertSchedule(entry({ coachId: 101, bookedNum: 19 }), { ambiguous: true });
  check("修复路径：Bala create", r.action, "created");
  const rows = await prisma.schedule.findMany();
  check("修复路径：库里 2 条", rows.length, 2);
  check("修复路径：酸酸的数没被顶掉", rows.find((x) => x.coachId === 102).bookedNum, 14);
}

// ─── 场景 5：平台不给教练（coachId null）→ 维持老口径按 课名+时分 ─────────────
__reset();
{
  const r1 = await upsertSchedule(entry({ coachId: null }));
  const r2 = await upsertSchedule(entry({ coachId: null, bookedNum: 20 }));
  check("无教练平台：updated", r2.action, "updated");
  check("无教练平台：id 稳定", r2.id, r1.id);
  check("无教练平台：库里 1 条", (await prisma.schedule.findMany()).length, 1);
}

// ─── 场景 6：库里已有重复 → 顺手合并成一条再更新 ─────────────────────────────
__reset();
{
  await prisma.schedule.create({ data: entry({ coachId: 102 }) });
  await prisma.schedule.create({ data: entry({ coachId: 102, bookedNum: 13 }) });
  const r = await upsertSchedule(entry({ coachId: 102 }));
  check("历史重复：updated + merged 1", [r.action, r.merged], ["updated", 1]);
  check("历史重复：库里 1 条", (await prisma.schedule.findMany()).length, 1);
}

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
