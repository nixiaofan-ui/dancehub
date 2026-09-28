/**
 * 校准 G-STEPS 分店的城市归属与店名后缀。
 *
 * 背景：G-STEPS 一次请求返回的是**全国**课表（北京 38 家 + 上海 2 家），
 * 早期抓取照抄了配置里的 `studio.city`（北京），导致上海新天地店、北外滩
 * 来福士店被挂到北京名下 —— 在北京界面里冒出上海分店。
 *
 * 校准依据：官方门店档案 `GET https://api.gsteps.cn/v2/studio/list` 的 city 字段，
 * 它明确给出 "北京市" / "上海市"，是权威来源。
 *
 * 为什么要**同时改名**：改了 cityId 但保留「（北京）」后缀的话，下次抓取时
 * 新数据的店名是「G-STEPS·上海新天地店（上海）」，跟库里的旧名字对不上，
 * 会被当成新门店再插一条 —— 上海分店变成两条（一条空壳挂北京）。
 * 先对齐名字，抓取才能命中已有记录。
 *
 * 用法：
 *   node server/tools/calibrate-gsteps-city.mjs           # 实际写入
 *   node server/tools/calibrate-gsteps-city.mjs --dry     # 只看会改什么
 */
import { PrismaClient } from "@prisma/client";
import { normalizeCityName, parseStudioName } from "../src/lib/calibrate-gsteps-city.js";

const DRY = process.argv.includes("--dry");
const prisma = new PrismaClient();
const API = "https://api.gsteps.cn/v2/studio/list";

async function main() {
  const resp = await fetch(API, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`门店档案 HTTP ${resp.status}`);
  const body = await resp.json();
  const list = Array.isArray(body?.res) ? body.res : [];
  if (!list.length) throw new Error("门店档案返回为空，拒绝继续（避免误改）");

  const cityOf = new Map();
  const addrOf = new Map();
  for (const s of list) {
    const name = String(s.name || "").trim();
    if (!name) continue;
    cityOf.set(name, normalizeCityName(s.city || s.province || ""));
    addrOf.set(name, String(s.address || "").trim());
  }
  console.log(`官方门店档案：${cityOf.size} 家`);
  const spread = {};
  for (const c of cityOf.values()) spread[c] = (spread[c] || 0) + 1;
  console.log("官方城市分布：", JSON.stringify(spread));

  const studios = await prisma.studio.findMany({
    where: { name: { startsWith: "G-STEPS" } },
    include: { city: true },
  });
  console.log(`库内 G-STEPS 门店：${studios.length} 家\n`);

  const cities = await prisma.city.findMany();
  const cityIdByName = new Map(cities.map((c) => [c.name, c.id]));

  let changed = 0;
  const skipped = [];

  for (const s of studios) {
    const parsed = parseStudioName(s.name);
    if (!parsed) {
      // 形如「G-STEPS·（北京）」——分店名为空的兜底记录，无从判定，保持原样
      skipped.push(`${s.name}：店名无法解析`);
      continue;
    }
    const real = cityOf.get(parsed.branch);
    if (!real) {
      skipped.push(`${s.name}：官方档案里没有这家分店`);
      continue;
    }
    const targetId = cityIdByName.get(real);
    if (!targetId) {
      skipped.push(`${s.name}：库里没有「${real}」这个城市`);
      continue;
    }
    if (s.cityId === targetId && parsed.suffix === real) continue;

    const newName = `G-STEPS·${parsed.branch}（${real}）`;
    const from = s.city?.name || `#${s.cityId}`;
    console.log(
      `改：${s.name}\n  ${from} → ${real}（cityId ${s.cityId} → ${targetId}）`,
    );
    if (addrOf.get(parsed.branch)) {
      console.log(`  官方地址：${addrOf.get(parsed.branch).slice(0, 40)}`);
    }
    changed += 1;

    if (!DRY) {
      await prisma.studio.update({
        where: { id: s.id },
        data: { cityId: targetId, name: newName },
      });
    }
  }

  console.log(`\n${DRY ? "将修改" : "已修改"} ${changed} 家，跳过 ${skipped.length} 家`);
  for (const s of skipped.slice(0, 10)) console.log("  跳过：" + s);

  if (DRY && changed) console.log("\n（--dry 模式，未写入。去掉 --dry 才会真正修改）");
}

main()
  .catch((e) => {
    console.error("失败：", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
