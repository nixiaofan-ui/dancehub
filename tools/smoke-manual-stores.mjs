/**
 * 手工建档（会员墙/闭源店的档案）烟测。
 *
 * 挂启动流程的东西必须幂等 —— 每次容器重启都会跑一遍，
 * 「重复建店」正是之前南京 D-DAY 那类事故的来源。
 *
 *   cd server && /usr/local/bin/node --import ../tools/prisma-stub-hooks.mjs ../tools/smoke-manual-stores.mjs
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { ensureManualStores } = await import("../server/src/lib/ensure-manual-stores.js");
const { prisma, __reset } = await import(new URL("./testing/fake-prisma-stub.mjs", import.meta.url));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`);
}

// ─── 城市不存在 → 不建店 ──────────────────────────────────────────────
__reset();
{
  const r = await ensureManualStores();
  check("城市未建：跳过不建店", [r.created, r.skipped], [0, 1]);
  check("城市未建：库里 0 条", (await prisma.studio.findMany()).length, 0);
}

// ─── 城市在 → 建店，字段齐 ────────────────────────────────────────────
__reset();
{
  await prisma.city.create({ data: { id: 1, name: "上海", region: "CN" } });
  const r = await ensureManualStores();
  check("首次：created 1", r.created, 1);

  const rows = await prisma.studio.findMany();
  check("库里 1 条", rows.length, 1);
  const s = rows[0];
  check("店名", s.name, "INSPACE舞蹈工作室");
  check("城市", s.cityId, 1);
  check("行政区（短名，和库里其他店一致）", s.district, "徐汇");
  check("地址写入", s.address, "上海市徐汇区裕德路111号南洋1931商场三楼05B");
  check("电话写入", s.contact, "15221215905 / 15221213580");
  check("不猜坐标", [s.lat, s.lng], [undefined, undefined]);
}

// ─── 重跑幂等（容器重启场景） ─────────────────────────────────────────
{
  const r = await ensureManualStores();
  check("重跑：created 0", r.created, 0);
  check("重跑：库里仍 1 条", (await prisma.studio.findMany()).length, 1);
}

// ─── 同名店在别的城市 → 该城市照样建 ──────────────────────────────────
__reset();
{
  await prisma.city.create({ data: { id: 1, name: "上海", region: "CN" } });
  await prisma.city.create({ data: { id: 14, name: "北京", region: "CN" } });
  await prisma.studio.create({ data: { name: "INSPACE舞蹈工作室", cityId: 14 } });
  const r = await ensureManualStores();
  check("同名店在别城：上海仍要建", r.created, 1);
  check("库里 2 条", (await prisma.studio.findMany()).length, 2);
}

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
