import { runCrawl } from "../src/crawler/index.js";

const id = process.argv[2] || "aiwugong-149-CLAP-dance-studio";
const dry = process.argv.includes("--dry");

const r = await runCrawl(id, { dryRun: dry });
console.log("配置:", id, "| dryRun:", dry);
console.log("结果:", JSON.stringify(r, null, 1).slice(0, 3000));

if (dry && Array.isArray(r.rows)) {
  console.log("\n共", r.rows.length, "条；样例前 6 条：");
  for (const x of r.rows.slice(0, 6)) {
    console.log(" ", x._date, "|", x.time, "|", x.courseName, "|", x.coach, "|", x._difficulty, "|", x._studioName, "|", x._roomName, "|", x.status);
  }
}
process.exit(0);
