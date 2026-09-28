/**
 * 迁移：把菲体云门店的课程名按新的 stripBranchPrefix() 规则原地刷一遍。
 *
 * 为什么必须有这个脚本：
 *   入库幂等键 = studioId + scheduleDate + startTime + courseName。
 *   engine 里一旦改了课名清洗规则，下一次抓取算出的键就跟库里已有行对不上，
 *   于是「同一节课」被当成新课再插一条 —— 而且接口不报错，静默变脏。
 *   所以改清洗必须同时刷库，两者必须跑在同一版 rules 上。
 *
 *   ⚠ engine.js::stripBranchPrefix() 改动后，本文件的同名函数必须逐字同步。
 *
 * 用法：
 *   node scripts/migrate-strip-branch-prefix.mjs          # dry-run，只报数
 *   node scripts/migrate-strip-branch-prefix.mjs --apply  # 真正写库
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

/** —— 必须与 engine.js::stripBranchPrefix 保持一致 —— */
function stripBranchPrefix(name) {
  const raw = String(name || "");
  const stripped = raw.replace(
    /^\s*[《【(（]?\s*[\u4e00-\u9fa5A-Za-z]{1,6}(店|校区|分校)\s*[》】)）]?\s*/,
    "",
  );
  return stripped.trim() ? stripped : raw;
}

/** 找出所有 fityun 配置的门店 id：配置里只有 name+city，靠这个组合反查库 */
async function fityunStudioIds() {
  const cfg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../src/crawler/studios.fityun.json"), "utf8"),
  );
  const keys = cfg.map((c) => [c.studio?.name, c.studio?.city].filter(Boolean).join("|"));
  const cities = [...new Set(cfg.map((c) => c.studio?.city).filter(Boolean))];
  const studios = await prisma.studio.findMany({
    where: { city: { name: { in: cities } } },
    select: { id: true, name: true, city: { select: { name: true } } },
  });
  const wanted = new Set(keys);
  return studios.filter((s) => wanted.has([s.name, s.city.name].join("|"))).map((s) => s.id);
}

async function main() {
  const ids = await fityunStudioIds();
  console.log(`菲体云门店 ${ids.length} 家`);
  if (!ids.length) return;

  const rows = await prisma.schedule.findMany({
    where: { studioId: { in: ids } },
    select: { id: true, studioId: true, courseName: true, scheduleDate: true, startTime: true },
  });
  const dirty = rows.filter((r) => stripBranchPrefix(r.courseName) !== r.courseName);
  console.log(`其中待清洗 ${dirty.length} / ${rows.length} 条`);
  dirty.slice(0, 8).forEach((r) => {
    console.log(`   #${r.id}  “${r.courseName}” → “${stripBranchPrefix(r.courseName)}”`);
  });
  if (!APPLY) {
    console.log("\n[dry-run] 加 --apply 才会写库");
    return;
  }

  // 同一门店+日期+时间已存在的课名，用来判定「清洗后会撞车」
  const existing = new Map();
  for (const r of rows) {
    const key = `${r.studioId}|${new Date(r.scheduleDate).toISOString().slice(0, 10)}|${new Date(
      r.startTime,
    ).toISOString()}|${r.courseName}`;
    existing.set(key, true);
  }

  let updated = 0;
  let deleted = 0;
  for (const r of dirty) {
    const next = stripBranchPrefix(r.courseName);
    const key = `${r.studioId}|${new Date(r.scheduleDate).toISOString().slice(0, 10)}|${new Date(
      r.startTime,
    ).toISOString()}|${next}`;
    if (existing.get(key)) {
      // 清洗后和目标行重复：留一条（目标行），删掉这条脏的
      await prisma.schedule.delete({ where: { id: r.id } });
      deleted += 1;
      continue;
    }
    await prisma.schedule.update({ where: { id: r.id }, data: { courseName: next } });
    existing.set(key, true);
    updated += 1;
  }
  console.log(`\n完成：更新 ${updated} 条，去重删除 ${deleted} 条`);
}

main()
  .catch((e) => console.error("ERR", e.message))
  .finally(() => prisma.$disconnect());
