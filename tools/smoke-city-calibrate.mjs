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
    // ⚠ 反面教材（真实数据踩过，id 824）：「中山五路」是广州的路，
    //   旧逻辑漏了带数字的路名 → 把广州的店判成了中山
    ["广州越秀区中山五路70号捷登都会负2楼（地铁公园前站E口）", "广州"],
    ["广州市天河区中山大道西100号", "广州"],
    ["广州市越秀区北京路238号", "广州"],
    // 真的是中山的地址仍然要认出来（靠「XX市」形态）
    ["中山市石岐区中山二路5号", "中山"],
    // 整条都是路名、没有城市 → null
    ["中山东路100号", null],
    // ⚠ 假命中（前端前缀边界）：山西「运城」嵌在「亚运城」里，东莞的店差点被搬去山西
    ["石楼镇亚运城碧乐时光2楼226铺", null],
    // ⚠ 假命中（后接地标词）：上海的店地址只写了「中山公园」没写「上海」
    ["中山公园|长风大悦城|长宁大融城|虹桥天街", null],
    // ⚠ 贪婪匹配漏城市：`{2,4}市` 会把「吉林省长春市」匹成「林省长春」→ 漏掉长春
    ["吉林省长春市南关区华润中心悦玺2103", "长春"],
    ["内蒙古自治区呼和浩特市新城区中山东路8号", "呼和浩特"],
    // 商场名含城市名不算数（「北京华联」在成都）
    ["四川省成都市双流区北京华联金港中心6楼", "成都"],
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

// ─── ⑦ 反面教材回归：广州的店不能被「中山五路」带到中山 ─────────────
// 真实数据：id 824「DT舞蹈禅城店」地址是「广州越秀区中山五路70号」，
// 旧逻辑把「中山五路」当成城市名 → 城市被改成了中山（本来是对的广州）。
__reset();
await prisma.city.create({ data: { id: 17, name: "广州", region: "CN" } });
await prisma.studio.create({
  data: {
    id: 824,
    name: "DT舞蹈禅城店",
    address: "广州越秀区中山五路70号捷登都会负2楼（地铁公园前站E口）",
    cityId: 17,
    status: true,
  },
});
{
  const r = await calibrateStudioCity();
  check("824 地址里带「中山五路」也不改（本来就是对的）", r.changed, 0);
  check("824 仍是广州", (await prisma.studio.findMany())[0].cityId, 17);
}

// ─── ⑧ 坐标判据：地址读不出城市时，坐标能定性就改 ─────────────────────
// 真实数据：广州的坐标框把深圳整个包住，10 家深圳店（八卦岭/车公庙/坂田/南山…）
// 全挂在了广州下。它们的地址只写「福田街道文蔚大厦」这种，读不出城市，
// 地址判据救不了 → 靠坐标：离广州参考点 95km、离深圳参考点 1km。
{
  __reset();
  await prisma.city.create({ data: { id: 17, name: "广州", region: "CN" } });
  const sz = await prisma.city.create({ data: { id: 18, name: "深圳", region: "CN" } });
  const gz = 17;
  // 广州 6 家（参考点稳在市中心）
  for (let i = 0; i < 6; i++) {
    await prisma.studio.create({
      data: { id: 500 + i, name: `广州店${i}`, address: null, cityId: gz, status: true,
        lat: 23.12 + i * 0.004, lng: 113.25 + i * 0.005 },
    });
  }
  // 深圳 4 家
  for (let i = 0; i < 4; i++) {
    await prisma.studio.create({
      data: { id: 520 + i, name: `深圳店${i}`, address: null, cityId: sz.id, status: true,
        lat: 22.54 + i * 0.003, lng: 114.05 + i * 0.004 },
    });
  }
  // 目标：地址读不出城市、坐标在福田
  await prisma.studio.create({
    data: { id: 401, name: "SPARK星光舞蹈工作室", address: "福田街道文蔚大厦4楼A2",
      cityId: gz, status: true, lat: 22.545, lng: 114.06 },
  });
  const r = await calibrateStudioCity();
  check("⑧ 坐标判据改了 1 家", r.changed, 1);
  check("⑧ 记在 byCoord 名下", r.byCoord, 1);
  check("⑧ 没走人工表", r.byOverride, 0);
  const s401 = (await prisma.studio.findMany()).find((s) => s.id === 401);
  check("⑧ 福田的店 → 深圳", s401.cityId, sz.id);
}

// ─── ⑨ 坐标判据的反面：大市域远郊不能动 ──────────────────────────────
// 重庆万州离主城 222km，但地址写着「重庆市万州区」，坐标也在万州 —— 它就是重庆的店。
{
  __reset();
  await prisma.city.create({ data: { id: 18, name: "深圳", region: "CN" } });
  const cq = await prisma.city.create({ data: { id: 19, name: "重庆", region: "CN" } });
  for (let i = 0; i < 5; i++) {
    await prisma.studio.create({
      data: { id: 600 + i, name: `重庆店${i}`, address: null, cityId: cq.id, status: true,
        lat: 29.56 + i * 0.003, lng: 106.55 + i * 0.004 },
    });
  }
  await prisma.studio.create({
    data: { id: 402, name: "红房子舞蹈万州店", address: "重庆市万州区白岩路一巷45号",
      cityId: cq.id, status: true, lat: 30.81, lng: 108.37 },
  });
  const r = await calibrateStudioCity();
  check("⑨ 万州店不动（远郊不是错）", r.changed, 0);
  const s402 = (await prisma.studio.findMany()).find((s) => s.id === 402);
  check("⑨ 万州店仍在重庆", s402.cityId, cq.id);
}

// ─── ⑩ 本城参考点不可信 → 宁可不改 ──────────────────────────────────
// 一座城只有 2 家有坐标时，中位数≈那两家自己，等于没有参考点 → 这座城退出判定。
// （中小城市常见：库里就只有它一家店，拿什么当参照？）
{
  __reset();
  await prisma.city.create({ data: { id: 18, name: "深圳", region: "CN" } });
  const ez = await prisma.city.create({ data: { id: 40, name: "鄂州", region: "CN" } });
  for (let i = 0; i < 2; i++) {
    await prisma.studio.create({
      data: { id: 700 + i, name: `鄂州店${i}`, address: null, cityId: ez.id, status: true,
        lat: 30.39 + i * 0.002, lng: 114.89 + i * 0.002 },
    });
  }
  await prisma.studio.create({
    data: { id: 403, name: "某店", address: null, cityId: ez.id, status: true,
      lat: 22.545, lng: 114.06 },
  });
  const r = await calibrateStudioCity();
  check("⑩ 本城参考点只有 2 家 → 不出手", r.changed, 0);
  const s403 = (await prisma.studio.findMany()).find((s) => s.id === 403);
  check("⑩ 店仍在鄂州", s403.cityId, ez.id);
}

// ─── ⑪ 地址判据优先于坐标判据 ───────────────────────────────────────
// 地址写明了城市就用地址 —— 坐标再怎么说也是二手数据，地址是商家自己填的。
{
  __reset();
  await prisma.city.create({ data: { id: 17, name: "广州", region: "CN" } });
  const sz = await prisma.city.create({ data: { id: 18, name: "深圳", region: "CN" } });
  for (let i = 0; i < 6; i++) {
    await prisma.studio.create({
      data: { id: 800 + i, name: `广州店${i}`, address: null, cityId: 17, status: true,
        lat: 23.12 + i * 0.004, lng: 113.25 + i * 0.005 },
    });
  }
  for (let i = 0; i < 4; i++) {
    await prisma.studio.create({
      data: { id: 820 + i, name: `深圳店${i}`, address: null, cityId: sz.id, status: true,
        lat: 22.54 + i * 0.003, lng: 114.05 + i * 0.004 },
    });
  }
  await prisma.studio.create({
    data: { id: 404, name: "Ｃ-5舞蹈深圳总店", address: "深圳市宝安区建安一路76号",
      cityId: 17, status: true, lat: 22.545, lng: 114.06 },
  });
  const r = await calibrateStudioCity();
  check("⑪ 地址判据改 1 家", r.changed, 1);
  check("⑪ 没走坐标判据", r.byCoord, 0);
  const s404 = (await prisma.studio.findMany()).find((s) => s.id === 404);
  check("⑪ 店改到深圳", s404.cityId, sz.id);
}

// ─── ⑫ 人工核定表优先于坐标判据 ─────────────────────────────────────
// id 935「GRADEMOVE DANCE」真实情况：坐标在昆明盘龙区，地址只写「北京路悦中心」
// （昆明的北京路），城市被生成器的关键词兜底误判成北京。地址读不出城市、
// 昆明参考点又只有它一家 → 坐标判据也救不了 → 只能人工核定。走 city-overrides.json。
{
  __reset();
  await prisma.city.create({ data: { id: 14, name: "北京", region: "CN" } });
  const km = await prisma.city.create({ data: { id: 118, name: "昆明", region: "CN" } });
  for (let i = 0; i < 5; i++) {
    await prisma.studio.create({
      data: { id: 900 + i, name: `北京店${i}`, address: null, cityId: 14, status: true,
        lat: 39.90 + i * 0.003, lng: 116.40 + i * 0.004 },
    });
  }
  await prisma.studio.create({
    data: { id: 935, name: "GRADEMOVE DANCE", address: "北京路悦中心1115、1116、2917、1721",
      cityId: 14, status: true, lat: 25.067696, lng: 102.725531 },
  });
  const r = await calibrateStudioCity();
  check("⑫ 人工表改了 1 家", r.changed, 1);
  check("⑫ 记在 byOverride 名下", r.byOverride, 1);
  check("⑫ 没走坐标判据", r.byCoord, 0);
  const s935 = (await prisma.studio.findMany()).find((s) => s.id === 935);
  check("⑫ 昆明的店 → 昆明", s935.cityId, km.id);
  const again = await calibrateStudioCity();
  check("⑫ 幂等：重跑 0", again.changed, 0);
}

// ─── ⑬ 改城市必须清 district ────────────────────────────────────────
// 区名候选表按城市限定（district-names.json 是 {城市:[区名]}）。不清的话就是
// 「绍兴的店挂着深圳的福田区」，而 fill-district 只填 null → 永远不会重抽。
{
  __reset();
  const sz = await prisma.city.create({ data: { id: 18, name: "深圳", region: "CN" } });
  await prisma.studio.create({
    data: { id: 405, name: "诸暨舞影旦斯街舞", address: "绍兴市越城区某路1号",
      cityId: sz.id, status: true, district: "福田" },
  });
  const r = await calibrateStudioCity();
  check("⑬ 改了 1 家", r.changed, 1);
  const s405 = (await prisma.studio.findMany()).find((s) => s.id === 405);
  check("⑬ 跨城后 district 已清空（等 fill-district 按新城市重抽）", s405.district, null);
}

// ─── ⑭ 参考点内聚度：城里混太多错店时整座城退出判定 ──────────────────
// 广州 52 家里混 11 家深圳店（19%）→ 中位数仍在广州，参考点可信；
// 但如果一半以上都偏了，参考点本身就不可信，这时必须放弃判定而不是照错的改。
{
  __reset();
  await prisma.city.create({ data: { id: 17, name: "广州", region: "CN" } });
  await prisma.city.create({ data: { id: 18, name: "深圳", region: "CN" } });
  // 广州 8 家：4 家真在广州 + 4 家远在关中（脏数据，挂广州）。
  // 中位数落在两地中间 → 8 家全都离参考点几百公里 → 内聚度 0% → 广州退出判定
  for (let i = 0; i < 4; i++) {
    await prisma.studio.create({
      data: { id: 950 + i, name: `广A${i}`, address: null, cityId: 17, status: true,
        lat: 23.12 + i * 0.004, lng: 113.25 + i * 0.005 },
    });
    await prisma.studio.create({
      data: { id: 960 + i, name: `广B${i}`, address: null, cityId: 17, status: true,
        lat: 34.0 + i * 0.004, lng: 108.0 + i * 0.005 },
    });
  }
  for (let i = 0; i < 4; i++) {
    await prisma.studio.create({
      data: { id: 970 + i, name: `深圳${i}`, address: null, cityId: 18, status: true,
        lat: 22.54 + i * 0.003, lng: 114.05 + i * 0.004 },
    });
  }
  await prisma.studio.create({
    data: { id: 406, name: "某店", address: null, cityId: 17, status: true,
      lat: 22.545, lng: 114.06 },
  });
  const r = await calibrateStudioCity();
  check("⑭ 广州参考点内聚度不足 → 全城不出手", r.changed, 0);
}

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
