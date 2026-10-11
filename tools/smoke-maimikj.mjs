/**
 * 脉脉科技 maimikj（CASTER）引擎烟测 —— 假 fetch 回放真实响应，不连网。
 *
 *   cd server && /usr/local/bin/node ../tools/smoke-maimikj.mjs
 *
 * 为什么必须有：这平台的坑都是「静默给错数据」型，不是报错型 ——
 *   ⛔ 缺请求头 `client-type: student` → 所有接口回 `{"code":500,"message":"非法客户端"}`，
 *      看起来像服务挂了；一旦有人「顺手」删掉那个头，功能整块失效但没人知道为什么。
 *   ⛔ 课表里的 store_title **有错别字**（同一 store_id 既有「黄浦人广来福士店」
 *      又有「黄埔人广来福士店」）→ 必须按 store_id 从门店接口映射，采信字符串就会
 *      在库里分裂出两家店、课表被劈成两半。
 *   ⛔ `level_name` 是**师资分类**（实测值有「外聘导师」）不是难度 → 拿它当难度会
 *      把「外聘导师」翻译成某个难度，语义全错。
 *   ⚠ 参数名是 `day` 不是 `date`；slng/slat 必传；teacher_phone 不能落库。
 */
import { register } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

const { crawl } = await import("../server/src/crawler/engine.js");
const { parseCapacity } = await import("../server/src/crawler/mapper.js");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`,
  );
}

/* ─── 真实响应 fixture（2026-10-11 实测抓下来，删掉无关长字段） ─── */

const STORELIST = {
  code: 200,
  data: [
    {
      id: 125,
      title: "黄浦人广来福士店",
      address: "上海市黄浦区西藏中路268号来福士广场5层",
      header_img: "",
      lng: "121.482645",
      lat: "31.238259",
    },
    {
      id: 107,
      title: "浦东陆家嘴中心馆",
      address: "上海市浦东新区世纪大道8号",
      header_img: "",
      lng: "121.505",
      lat: "31.239",
    },
    // 品牌旗下但没接入配置的店 → 课一律不落
    {
      id: 999,
      title: "不接入的店",
      address: "上海市某处",
      lng: "121.4",
      lat: "31.2",
    },
  ],
};

const ROWS = [
  // ① 常态：课名尾部的 ⭐ 原样保留；已约是**实时直给**
  {
    id: 308274,
    title: "JAZZ 基础⭐⭐",
    style_name: "JAZZ",
    level_name: "0基础",
    start_time: "14:05:00",
    end_time: "15:05:00",
    store_id: 125,
    // ⛔ 错别字（门店接口里是「黄浦…」）→ 断言最终用的是对的那个
    store_title: "黄埔人广来福士店",
    room_title: "A教室",
    teacher_real_name: "苟雪琴",
    teacher_phone: "15000749850",
    head_img: "http://caster-2017.oss-cn-hangzhou.aliyuncs.com/upload/20220727/14ce92a7cc92cf37f141a21a6ff5c9f5.jpg",
    seat_occupied_number: 12,
    seat_number: 30,
  },
  // ② 满员
  {
    id: 308275,
    title: "HIPHOP ⭐",
    level_name: "0基础",
    start_time: "19:00:00",
    end_time: "20:00:00",
    store_id: 125,
    store_title: "黄浦人广来福士店",
    room_title: "B教室",
    teacher_real_name: "阿昊",
    teacher_phone: "13800000000",
    head_img: "http://caster-2017.oss-cn-hangzhou.aliyuncs.com/upload/20240607/a29cb431137973a4584be7ce51267ef3.JPG",
    seat_occupied_number: 20,
    seat_number: 20,
  },
  // ③ 空课名 → 整行丢弃
  {
    id: 308276,
    title: "   ",
    store_id: 107,
    store_title: "浦东陆家嘴中心馆",
    start_time: "10:00:00",
    end_time: "11:00:00",
    seat_number: 10,
    seat_occupied_number: 1,
  },
  // ④ 没接入的门店 → 丢弃
  {
    id: 308277,
    title: "不该出现的课",
    store_id: 999,
    store_title: "不接入的店",
    start_time: "10:00:00",
    end_time: "11:00:00",
    seat_number: 10,
    seat_occupied_number: 1,
  },
  // ⑤ 字段缺失 + level_name 是师资分类（「外聘导师」绝不能变成难度）
  {
    id: 308278,
    title: "URBAN  初阶",
    level_name: "外聘导师",
    start_time: "20:30:00",
    end_time: "21:30:00",
    store_id: 107,
    store_title: "浦东陆家嘴中心馆",
    room_title: "",
    teacher_real_name: "NINE",
    teacher_phone: "",
    head_img: null,
    seat_occupied_number: null,
    seat_number: null,
  },
];

const CONFIG = {
  id: "maimikj-caster",
  mode: "maimikj",
  studio: { name: "CASTER", city: "上海", region: "CN" },
  maimikj: {
    baseUrl: "https://caster2021.casterstudio.com/api",
    slng: "121.4737",
    slat: "31.2304",
    storeIds: [125, 107],
    // 故意调到 2：验证分页能把 5 条完整捞回（大促日课程变多时不能只拿第一页）
    pageSize: 2,
  },
};

/* ─── 假 fetch ───────────────────────────────────────────────────────────── */

let calls = [];
let scenario = "ok";

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, headers: init.headers || {} });
  const json = (b) => ({ ok: true, status: 200, json: async () => b });

  if (u.includes("/v1/student/store/storelist")) {
    if (scenario === "badClient") return json({ code: 500, message: "非法客户端" });
    return json(STORELIST);
  }
  if (u.includes("/v1/student/course/casterlist")) {
    const sp = new URL(u).searchParams;
    const page = Number(sp.get("page"));
    const size = Number(sp.get("size"));
    return json({
      code: 200,
      data: { count: ROWS.length, data: ROWS.slice((page - 1) * size, page * size) },
    });
  }
  throw new Error("未预期的请求: " + u);
};

/* ─── 主流程 ─────────────────────────────────────────────────────────────── */

const BASE = new Date("2026-10-11T00:00:00Z");
const rows = await crawl(CONFIG, BASE);

const schedCalls = calls.filter((c) => c.url.includes("casterlist"));

check(
  "⛔⛔ 每个请求都带 client-type: student（缺了整块功能静默失效）",
  calls.every((c) => c.headers["client-type"] === "student"),
  true,
);
check(
  "⛔ 参数名是 day=（不是 date=）",
  schedCalls.every((c) => c.url.includes("day=2026-10-11")) &&
    schedCalls.some((c) => c.url.includes("date=")),
  false,
);
check(
  "⛔ 必须带 slng/slat（不传报 Undefined index: slng）",
  schedCalls.every((c) => c.url.includes("slng=121.4737") && c.url.includes("slat=31.2304")),
  true,
);
check("store_id=0 一次带出全部门店", schedCalls.every((c) => c.url.includes("store_id=0")), true);
check("分页把 5 条捞全（pageSize=2 → 3 页）", schedCalls.length, 3);
check("门店接口只调 1 次（进程内缓存，不按天重复打）", calls.filter((c) => c.url.includes("storelist")).length, 1);

check("最终 3 条有效课（空课名 + 未接入门店各丢 1 条）", rows.length, 3);
check("门店档案只建配置里列出的 2 家", rows.ensureStudios.length, 2);

const byName = (n) => rows.find((r) => r.courseName === n);

{
  const r = byName("JAZZ 基础⭐⭐");
  check("⛔ 门店名按 store_id 映射（丢掉课表里的错别字「黄埔」）", r._studioName, "CASTER·黄浦人广来福士店");
  check("课名尾部的 ⭐ 原样保留（含义未证实，不自作主张去掉）", r.courseName, "JAZZ 基础⭐⭐");
  check("教练实名", r.coach, "苟雪琴");
  check("⭐ head_img 是教练头像", r._coachAvatar, "http://caster-2017.oss-cn-hangzhou.aliyuncs.com/upload/20220727/14ce92a7cc92cf37f141a21a6ff5c9f5.jpg");
  check("时间（带秒的时间串要能解析）", r.time, "14:05:00-15:05:00");
  check("已约/容量", r.capacity, "12/30");
  check("capacity 解析", parseCapacity(r.capacity), 30);
  check("⭐ seat_occupied_number 是已约（实时直给）", r._bookedNum, 12);
  check("status 可预约", r.status, "可预约");
  check("教室", r._roomName, "A教室");
  check("地址随门店落（课表接口没有，得从门店接口带过来）", r._address, "上海市黄浦区西藏中路268号来福士广场5层");
  check("坐标（纬度）", r._lat, 31.238259);
  check("坐标（经度）", r._lng, 121.482645);
  check("城市", r._city, "上海");
}

{
  const r = byName("HIPHOP ⭐");
  check("满员 → status 已满", r.status, "已满");
  check("满员已约 20", r._bookedNum, 20);
}

{
  const r = byName("URBAN  初阶");
  check("没有容量 → capacity 空串", r.capacity, "");
  check("没有已约 → bookedNum 是 null 不是 0", r._bookedNum, null);
  check("⛔ level_name「外聘导师」不是难度 → 不标（走课名规则）", r._difficulty, undefined);
  check("没有头像 → null", r._coachAvatar, null);
  check("门店切到第二家", r._studioName, "CASTER·浦东陆家嘴中心馆");
}

check(
  "未接入门店的课没有漏进来",
  rows.every((r) => r._studioName !== "CASTER·不接入的店"),
  true,
);

/* ─── 配置缺失 + 客户端头错误要能看见 ────────────────────────────────────── */

async function expectThrow(label, cfg, sc = "ok") {
  scenario = sc;
  let msg = "";
  try {
    await crawl(cfg, BASE);
  } catch (e) {
    msg = e.message;
  }
  scenario = "ok";
  const ok = msg.includes("脉脉科技") || msg.includes("maimikj");
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? `  → "${msg}"` : `  期望抛错，实得 ${JSON.stringify(msg)}`}`);
}

await expectThrow("缺 storeIds → 抛错（不是静默空）", {
  ...CONFIG,
  maimikj: { ...CONFIG.maimikj, storeIds: [] },
});
{
  // ⚠ 必须换 baseUrl：门店清单走**进程内缓存**，沿用 CONFIG 的 baseUrl 会直接命中
  //   上面成功那次留下的缓存 → 不发请求也不抛错，测试会假绿。（魔方烟测踩过同一个坑）
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.maimikj.baseUrl = "https://caster-bad.example.com/api";
  await expectThrow(
    "⛔ 缺 client-type 头 → 接口回「非法客户端」，必须抛出来（不能吞成空课表）",
    cfg,
    "badClient",
  );
}

/* ─── 入库：走真实 importer ──────────────────────────────────────────────── */

const { importSchedules } = await import("../server/src/crawler/importer.js");
const { prisma, __reset } = await import(new URL("./testing/fake-prisma-stub.mjs", import.meta.url));

__reset();
calls = [];
const live = await crawl(CONFIG, BASE);
// ⚠ `_date` 平时由 runCrawl 注入，单测直调 importer 得自己补
const dated = (rs) => rs.map((r) => ({ ...r, _date: BASE }));
const res1 = await importSchedules(CONFIG, dated(live), live.ensureStudios);

check("首轮：3 节全部入库", res1.created["CASTER·黄浦人广来福士店"] + res1.created["CASTER·浦东陆家嘴中心馆"], 3);
check("首轮：没有跳过", res1.skipped, 0);

const studios = await prisma.studio.findMany();
check("建了 2 家门店", studios.length, 2);
check(
  "⛔ 库里只有正确写法的那家（错别字店名不该分裂出第二家）",
  studios.map((s) => s.name).sort(),
  ["CASTER·黄浦人广来福士店", "CASTER·浦东陆家嘴中心馆"].sort(),
);
check("门店地址入库", studios.find((s) => s.name === "CASTER·黄浦人广来福士店").address, "上海市黄浦区西藏中路268号来福士广场5层");

const coaches = await prisma.coach.findMany();
check("教练 3 位", coaches.map((c) => c.name).sort(), ["NINE", "阿昊", "苟雪琴"].sort());
check(
  "⭐ 教练头像入库",
  coaches.find((c) => c.name === "苟雪琴").avatarUrl,
  "http://caster-2017.oss-cn-hangzhou.aliyuncs.com/upload/20220727/14ce92a7cc92cf37f141a21a6ff5c9f5.jpg",
);
check(
  "⛔ teacher_phone 绝不落库",
  JSON.stringify(coaches).includes("15000749850"),
  false,
);

const scheds = await prisma.schedule.findMany();
check("课表 3 条", scheds.length, 3);
{
  const r = scheds.find((s) => s.courseName === "JAZZ 基础⭐⭐");
  check("已约人数入库", r.bookedNum, 12);
  check("容量入库", r.capacity, 30);
  check("开始时间是北京 14:05", r.startTime.toISOString().slice(11, 16), "06:05");
  check("教室进了 remark", String(r.remark || "").includes("A教室"), true);
}

// 幂等：第二轮不该重复建店/建课
const res2 = await importSchedules(CONFIG, dated(await crawl(CONFIG, BASE)), live.ensureStudios);
check(
  "重跑：created 全 0",
  (res2.created["CASTER·黄浦人广来福士店"] || 0) + (res2.created["CASTER·浦东陆家嘴中心馆"] || 0),
  0,
);
check("重跑：门店仍 2 家", (await prisma.studio.findMany()).length, 2);
check("重跑：课仍 3 条", (await prisma.schedule.findMany()).length, 3);
check("重跑：教练仍 3 位", (await prisma.coach.findMany()).length, 3);

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
