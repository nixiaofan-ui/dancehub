/**
 * 门店城市校正烟测（lib/city-names.js + lib/calibrate-studio-city.js）。
 *
 * 这个模块要改的是**存量数据的城市归属**，改错了用户按城市就搜不到店，
 * 所以要盯住三件事：
 *   ① 抽取规则：地址写明别的城市才改；地址读不出城市一律不动（宁可不改）。
 *   ② 不误伤：海外店、status=false 的店、路名（「北京中路银川…」）都不能碰。
 *   ③ 幂等：容器每次重启都会跑，重跑必须 changed=0。
 *
 *   cd server && /usr/local/bin/node --import ../tools/prisma-stub-hooks.mjs ../tools/smoke-city-calibrate.mjs
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { cityFromAddress } = await import("../server/src/lib/city-names.js");
const { calibrateStudioCity } = await import(
  "../server/src/lib/calibrate-studio-city.js"
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

// ─── ① 地址抽城市：这是整套机制的判据，抽错了下面全是错的 ──────────────
{
  const cases = [
    ["天津市和平区", "天津"],
    ["佛山市禅城区祖庙路24号兴华商场3楼", "佛山"],
    ["广东省佛山市高明区盈信广场内3楼", "佛山"],
    ["珠海市香洲区茂业百货四楼", "珠海"],
    ["拉萨市城关区塔玛南路22号", "拉萨"],
    ["广州市荔湾区鹤洞路235号", "广州"],
    ["北京市通州区九棵树金成中心1402", "北京"],
    ["常州市钟楼区百货大楼3楼", "常州"],
    // 路名干扰：这是银川的「北京路」，不是北京
    ["北京中路银川文化城凤凰幻城肆区十栋D10-105、106", "银川"],
    // 抽不出城市 → null（不能猜）
    ["麦子店街53号亮马港湾大厦2E", null],
    ["", null],
    // 「XX市」形态里带「超市」这类噪声字也不该误判
    ["上海市浦东新区世纪大道100号", "上海"],
  ];
  for (const [addr, want] of cases) {
    check(`抽城市：${addr.slice(0, 24) || "(空)"}`, cityFromAddress(addr), want);
  }
}

/** 建一家店（默认在「北京」城下，带地址） */
async function seedStudio({ id, name, address, cityId = 14, status = true }) {
  await prisma.studio.create({ data: { id, name, address, cityId, status } });
}

await prisma.city.create({ data: { id: 14, name: "北京", region: "CN" } });
await prisma.city.create({ data: { id: 17, name: "广州", region: "CN" } });
await prisma.city.create({ data: { id: 30, name: "首尔", region: "OVERSEAS" } });

// ─── ② 坐标框包住邻市 → 按地址改正 ───────────────────────────────────
await seedStudio({ id: 101, name: "DT舞蹈禅城店", address: "佛山市禅城区祖庙路24号" });
await seedStudio({ id: 102, name: "圣捷分店", address: "天津市和平区" });
await seedStudio({ id: 103, name: "爱舞功开发版", address: "广州市荔湾区鹤洞路235号" });
{
  const r = await calibrateStudioCity();
  check("改了 3 家", r.changed, 3);
  check("新建城市：佛山、天津", r.createdCities, ["佛山", "天津"]);
  const byId = new Map((await prisma.city.findMany()).map((c) => [c.id, c.name]));
  const rows = await prisma.studio.findMany();
  const bySid = new Map(rows.map((s) => [s.id, s]));
  check("DT舞蹈禅城店 → 佛山", byId.get(bySid.get(101).cityId), "佛山");
  check("圣捷分店 → 天津", byId.get(bySid.get(102).cityId), "天津");
  check("爱舞功开发版 → 广州（不是注册地北京）", byId.get(bySid.get(103).cityId), "广州");
}

// ─── ③ 幂等：重启会再跑一次，不能一直改 ─────────────────────────────
{
  const r = await calibrateStudioCity();
  check("重跑 changed 0", r.changed, 0);
  check("重跑 createdCities 空", r.createdCities, []);
}

// ─── ④ 地址读不出城市 → 一动不动（宁可不改也不猜） ────────────────────
__reset();
await prisma.city.create({ data: { id: 14, name: "北京", region: "CN" } });
await seedStudio({ id: 201, name: "1758DanceStudio(亮马店)", address: "麦子店街53号亮马港湾大厦2E" });
{
  const r = await calibrateStudioCity();
  check("抽不出城市：changed 0", r.changed, 0);
  check("抽不出城市：skipped 1", r.skipped, 1);
  check("抽不出城市：店还在北京", (await prisma.studio.findMany())[0].cityId, 14);
}

// ─── ⑤ 海外店与隐藏店不碰 ───────────────────────────────────────────
{
  await prisma.city.create({ data: { id: 30, name: "首尔", region: "OVERSEAS" } });
  // 海外店地址里带中国城市名也不该被挪（它本来就该在首尔）
  await prisma.studio.create({
    data: { id: 202, name: "1MILLION", address: "广州市荔湾区某路1号", cityId: 30, status: true },
  });
  // 隐藏店（已下线的重复项）不该被校正
  await prisma.studio.create({
    data: { id: 203, name: "某隐藏店", address: "佛山市禅城区", cityId: 14, status: false },
  });
  const r = await calibrateStudioCity();
  check("海外+隐藏：changed 0", r.changed, 0);
  const bySid = new Map((await prisma.studio.findMany()).map((s) => [s.id, s]));
  check("海外店仍在首尔", bySid.get(202).cityId, 30);
  check("隐藏店仍是北京", bySid.get(203).cityId, 14);
}

// ─── ⑥ 多家店同城同名不该互相影响（各自按自己地址判） ─────────────────
__reset();
await prisma.city.create({ data: { id: 17, name: "广州", region: "CN" } });
await prisma.studio.create({
  data: { id: 301, name: "超节拍·高明校区", address: "广东省佛山市高明区盈信广场", cityId: 17, status: true },
});
await prisma.studio.create({
  data: { id: 302, name: "超节拍·里水店", address: "佛山市南海区里水大道76号", cityId: 17, status: true },
});
{
  const r = await calibrateStudioCity();
  check("同名族两家都改", r.changed, 2);
  const fushan = (await prisma.city.findMany()).find((c) => c.name === "佛山");
  const bySid = new Map((await prisma.studio.findMany()).map((s) => [s.id, s]));
  check("301（高明）→ 佛山", bySid.get(301).cityId, fushan.id);
  check("302（里水）→ 佛山", bySid.get(302).cityId, fushan.id);
  check("只新建了一个「佛山」", (await prisma.city.findMany()).filter((c) => c.name === "佛山").length, 1);
}

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
