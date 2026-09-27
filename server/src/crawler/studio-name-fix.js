/**
 * 爱舞功系店名修复（品牌名 + 分店名）。
 *
 * 本地脚本 tools/fix-aiwugong-studio-names.mjs 和云端
 * POST /api/crawler/fix-studio-names 共用这一份逻辑 —— 云库没开公网时，
 * 改线上数据只能走 HTTP 端点，两边各写一份必然漂移。
 *
 * 两个动作：
 *   - 名字唯一：原地改名（课程/关注/预约全部保留，Studio.id 不变）
 *   - 名字歧义：整条 Studio 连课程删除，等下一轮抓取重建
 *     （这些记录本来就是多个品牌混在一起的，改名救不回来）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";
import { composeStudioName } from "./studio-name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(__dirname, "studios.aiwugong.json");

/** 依配置算出 old → 候选 new 的映射 */
function buildPlan() {
  const configs = JSON.parse(fs.readFileSync(CFG_PATH, "utf8")).filter((c) => c.enabled);
  const plan = new Map();
  for (const c of configs) {
    const brand = c.studio?.name || "";
    const branches = c.aiwugong?.branches?.length ? c.aiwugong.branches : [{}];
    for (const br of branches) {
      const oldName = (br.name || brand).trim();
      const newName = composeStudioName(brand, br.name);
      if (!oldName || oldName === newName) continue;
      if (!plan.has(oldName)) plan.set(oldName, new Set());
      plan.get(oldName).add(newName);
    }
  }
  return { configs, plan };
}

async function analyze() {
  const { configs, plan } = buildPlan();
  const hosts = [...new Set(configs.map((c) => c.aiwugong?.host).filter(Boolean))];
  const studios = await prisma.studio.findMany({
    where: { bookingMiniAppId: { in: hosts } },
    select: { id: true, name: true },
  });
  const byName = new Map(studios.map((s) => [s.name, s]));
  const existingNames = new Set(studios.map((s) => s.name));

  const renames = [];
  const ambiguous = [];
  for (const [oldName, newNames] of plan) {
    const studio = byName.get(oldName);
    if (!studio) continue; // 该分店当时没课，没入库
    if (newNames.size > 1) ambiguous.push({ studio, newNames: [...newNames] });
    else renames.push({ studio, newName: [...newNames][0] });
  }
  // 改名后撞上已存在的记录 → 跳过，不覆盖别人的数据
  const conflicts = renames.filter((r) => existingNames.has(r.newName));
  const conflictIds = new Set(conflicts.map((c) => c.studio.id));

  // 安全闸：有用户预约/提醒的门店不删（删了会让用户的提醒指向不存在的课）
  const guarded = [];
  for (const a of ambiguous) {
    const schedules = await prisma.schedule.findMany({
      where: { studioId: a.studio.id },
      select: { id: true },
    });
    const ids = schedules.map((s) => s.id);
    if (!ids.length) continue;
    const [bookings, reminders] = await Promise.all([
      prisma.booking.count({ where: { scheduleId: { in: ids } } }),
      prisma.reminder.count({ where: { scheduleId: { in: ids } } }),
    ]);
    if (bookings || reminders) {
      guarded.push({ name: a.studio.name, bookings, reminders });
    }
  }
  const guardIds = new Set(
    guarded.map((g) => ambiguous.find((a) => a.studio.name === g.name)?.studio.id),
  );

  const courseCount = async (studioId) => prisma.schedule.count({ where: { studioId } });
  const detail = [];
  for (const a of ambiguous) {
    detail.push({ name: a.studio.name, courses: await courseCount(a.studio.id), split: a.newNames });
  }

  return {
    total: studios.length,
    renames: renames.filter((r) => !conflictIds.has(r.studio.id)),
    conflicts,
    ambiguous,
    detail,
    guarded,
    guardIds,
  };
}

/** 只算不改，返回将要发生什么 */
export async function previewStudioNameFix() {
  const a = await analyze();
  return {
    studios: a.total,
    rename: a.renames.length,
    conflict: a.conflicts.map((c) => ({ from: c.studio.name, to: c.newName })),
    ambiguous: a.detail,
    guarded: a.guarded,
  };
}

/** 真正执行 */
export async function applyStudioNameFix() {
  const a = await analyze();
  let renamed = 0;
  for (const r of a.renames) {
    await prisma.studio.update({ where: { id: r.studio.id }, data: { name: r.newName } });
    renamed += 1;
  }
  let deleted = 0;
  let removedCourses = 0;
  for (const amb of a.ambiguous) {
    if (a.guardIds.has(amb.studio.id)) continue;
    const res = await prisma.schedule.deleteMany({ where: { studioId: amb.studio.id } });
    removedCourses += res.count;
    await prisma.coach.deleteMany({ where: { studioId: amb.studio.id } });
    await prisma.follow.deleteMany({ where: { studioId: amb.studio.id } });
    await prisma.studio.delete({ where: { id: amb.studio.id } });
    deleted += 1;
  }
  return { renamed, deleted, removedCourses, guarded: a.guarded };
}
