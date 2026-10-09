/**
 * 门店改名自愈烟测。
 *
 * 挂启动流程 + 抓取前的东西必须**幂等**且**不误伤**：
 *  - 改名错一户 = 那家店的课表/关注/提醒整批挪到别人名下（不可逆）；
 *  - 改名漏跑一次 = 下一轮抓取再建一条空壳店（南京 D-DAY 那类事故）。
 *
 * 配置里的 legacyNames 是这个机制的唯一数据来源，所以这里既测「配置读得出来」
 * （两边对接不上时自愈就静默失效），也测库里的四种情形。
 *
 *   cd server && /usr/local/bin/node --import ../tools/prisma-stub-hooks.mjs ../tools/smoke-studio-renames.mjs
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { renameStudios, collectRenames } = await import(
  "../server/src/lib/rename-studios.js"
);
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

/** 每次跑都清干净：模块内的「一次」标记不在这里管（最后单独测） */
const OLD = "11A DANCE·保利中心店（武侯）";
const NEW = "11A DANCE";

async function seed({ withOld = true, withNew = false, city = "成都", cityId = 18 } = {}) {
  __reset();
  await prisma.city.create({ data: { id: cityId, name: city, region: "CN" } });
  if (withOld) {
    await prisma.studio.create({
      data: { id: 2296, name: OLD, cityId, address: "四川省成都市武侯区保利中心东区C座" },
    });
  }
  if (withNew) {
    await prisma.studio.create({ data: { id: 3001, name: NEW, cityId } });
  }
}

// ─── ① 配置侧：legacyNames 读得出来（读不出 = 自愈静默失效） ───────────
{
  const pairs = collectRenames();
  const hit = pairs.filter((p) => p.legacy === OLD);
  check("配置里能读到 11A 的旧名", hit.length, 1);
  check("现名是 11A DANCE", hit[0] && hit[0].name, NEW);
  check("城市是成都", hit[0] && hit[0].city, "成都");
  // 旧名 == 现名 的废配置不该产生「给自己改名」的活
  check("没有自我改名的条目", pairs.filter((p) => p.name === p.legacy).length, 0);
}

// ─── ② 正常改名：只动同城那一条 ───────────────────────────────────────
await seed({});
// 别的城市恰好也有一条同名旧记录 —— 绝不能被顺手改掉
await prisma.city.create({ data: { id: 14, name: "北京", region: "CN" } });
await prisma.studio.create({ data: { id: 999, name: OLD, cityId: 14 } });
{
  const r = await renameStudios({ force: true });
  check("改 1 家", r.changed, 1);
  const byId = new Map((await prisma.studio.findMany()).map((s) => [s.id, s]));
  check("成都那条已改名", byId.get(2296).name, NEW);
  check("改名没动 id", byId.get(2296).id, 2296);
  check("改名没动地址", byId.get(2296).address, "四川省成都市武侯区保利中心东区C座");
  check("同一旧名在别的城市不动", byId.get(999).name, OLD);
}

// ─── ③ 幂等：重跑不再改（容器每次重启都会跑一遍） ─────────────────────
{
  const r = await renameStudios({ force: true });
  check("重跑 changed 0", r.changed, 0);
  check("重跑 skipped 0（旧名已不存在，不算跳过）", r.skipped, 0);
  const rows = await prisma.studio.findMany();
  check("库里还是 2 条（没有新建）", rows.length, 2);
}

// ─── ④ 撞名跳过：目标名字已存在 → 不动手，交给重复门店自愈 ─────────────
await seed({ withOld: true, withNew: true });
{
  const r = await renameStudios({ force: true });
  check("撞名：changed 0", r.changed, 0);
  check("撞名：skipped 1", r.skipped, 1);
  const rows = await prisma.studio.findMany();
  check("撞名：旧记录保持原样", rows.find((s) => s.id === 2296).name, OLD);
}

// ─── ⑤ 城市没建过 → 跳过（店还没入库，什么都不用做） ─────────────────
await seed({});
await prisma.city.deleteMany({ where: {} });
{
  const r = await renameStudios({ force: true });
  check("城市不存在：changed 0", r.changed, 0);
  check("城市不存在：skipped 1", r.skipped, 1);
  check("城市不存在：库里有旧名记录但不改", (await prisma.studio.findMany())[0].name, OLD);
}

// ─── ⑥ 「一个进程只跑一次」：不带 force 的第二次调用直接返回 ──────────
await seed({});
{
  const r = await renameStudios();
  check("未 force：已经跑过就不再查库", [r.checked, r.changed, r.skipped], [0, 0, 0]);
  const rows = await prisma.studio.findMany();
  check("未 force：库里没被改成新名", rows[0].name, OLD);
}

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
