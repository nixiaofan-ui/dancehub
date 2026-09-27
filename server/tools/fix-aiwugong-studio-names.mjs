/**
 * 本地执行爱舞功系店名修复（补上品牌名）。
 * 逻辑在 src/crawler/studio-name-fix.js，与云端端点共用，别在这里另写一份。
 *
 * 用法：
 *   node server/tools/fix-aiwugong-studio-names.mjs           # 预演
 *   node server/tools/fix-aiwugong-studio-names.mjs --apply    # 执行
 *
 * 云端改数据走：curl -X POST .../api/crawler/fix-studio-names -H "x-admin-token: ..." -d '{"apply":true}'
 */
import { previewStudioNameFix, applyStudioNameFix } from "../src/crawler/studio-name-fix.js";
import { prisma } from "../src/lib/prisma.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!APPLY) {
    const p = await previewStudioNameFix();
    console.log(`爱舞功系门店 ${p.studios} 条`);
    console.log(`改名 ${p.rename} 条，撞名跳过 ${p.conflict.length} 条`);
    p.conflict.slice(0, 10).forEach((c) => console.log(`  ⚠ ${c.from} → ${c.to}（已存在）`));
    console.log(`\n歧义（删除重建）${p.ambiguous.length} 条：`);
    p.ambiguous
      .slice(0, 15)
      .forEach((a) => console.log(`  ✗ 「${a.name}」${a.courses} 节课 → ${a.split.join(" / ")}`));
    if (p.ambiguous.length > 15) console.log(`  ... 另有 ${p.ambiguous.length - 15} 条`);
    if (p.guarded.length) {
      console.log(`\n⛔ 有用户数据、跳过删除：${p.guarded.map((g) => g.name).join("、")}`);
    }
    console.log("\n[预演] 未写库。加 --apply 执行。");
    return;
  }
  const r = await applyStudioNameFix();
  console.log(
    `完成：改名 ${r.renamed} 条，删除 ${r.deleted} 条（清掉 ${r.removedCourses} 节错配的课）`
  );
  if (r.guarded.length) console.log(`跳过（有预约/提醒）：${r.guarded.map((g) => g.name).join("、")}`);
  console.log("下一步：重跑 node server/tools/run-aiwugong.mjs --all 重建被删门店的课表");
}

main()
  .catch((e) => {
    console.error("失败:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
