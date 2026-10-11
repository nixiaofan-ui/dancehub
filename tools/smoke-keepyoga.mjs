/**
 * 随心瑜 keepyoga（vcloud.keepyoga.com）引擎烟测 —— 假 fetch 回放真实响应，不连网。
 *
 *   cd server && /usr/local/bin/node ../tools/smoke-keepyoga.mjs
 *
 * 为什么必须有：这套接口的坑全在「名字看起来对但位置不对」上 ——
 *   ⚠ API base 是根路径（`/course/api/wxccourselist`），**不是**页面所在的 `/weixin/...`。
 *     照着页面 URL 前缀去拼会 404，肉眼 review 看不出来，只有真发请求才暴露。
 *   ⚠ occupied 是**已约**、remain_num 是剩余 —— 拿反了整页人数全错（这里是直给已约，
 *     不需要像 iWOD 那样从 remain 反算，但也正因如此更容易把两个字段接错）。
 *   ⚠ 某家店参数失效时接口返回 errno≠0（不是 HTTP 错）→ 必须「跳过这家店、继续别家」，
 *     整条链不能因为一家店断掉。
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

/* ─── 真实响应 fixture（2026-10-11 实测抓下来） ─── */

const BRAND_ID = "M01_R0tRVGJMdEJML2s9";

const VENUES = [
  { id: "1", name: "长宁古北", city: "上海", contact: "18321004204" },
  { id: "2", name: "静安星贸", city: "上海", contact: "18930852561" },
  { id: "3", name: "普陀曹杨", city: "上海", contact: "17701845361" },
];

const LIST_BY_VENUE = {
  1: [
    {
      course_id: "163",
      schedule_id: "47383",
      course_name: "基本功训练",
      coach_name: "dd",
      course_size: "35",
      occupied: "9",
      remain_num: "26",
      start: "15:00",
      end: "16:00",
      classroom: "落地窗大教室A",
      course_diff_level: "1",
      coach_avatar: "https://img.keepyoga.com/1698912249_9427_pic.jpg@q_80,w_200,h_200",
    },
    // 课名首尾带「.」装饰符 → 必须洗净（否则每次抓取都会跟库里已有行判重失败）
    {
      course_id: "9",
      schedule_id: "47400",
      course_name: ".K-POP.",
      coach_name: "嘉嘉",
      course_size: "40",
      occupied: "40",
      remain_num: "0",
      start: "15:00",
      end: "16:00",
      classroom: "大教室（A）",
      course_diff_level: "2",
      coach_avatar: "https://img.keepyoga.com/1688620422_5880_pic.jpg@q_80,w_200,h_200",
    },
    // 没有容量、没有已约 → 不能编出数字
    {
      course_id: "10",
      schedule_id: "47401",
      course_name: "URBAN",
      coach_name: "小鹿",
      course_size: null,
      occupied: null,
      remain_num: null,
      start: "20:30",
      end: "21:30",
      classroom: "",
      course_diff_level: "9",
      coach_avatar: null,
    },
    // 空课名 → 整行丢弃
    {
      course_id: "11",
      schedule_id: "47402",
      course_name: "   ",
      coach_name: "x",
      course_size: "10",
      occupied: "1",
      start: "09:00",
      end: "10:00",
      course_diff_level: "1",
    },
  ],
  2: [
    {
      course_id: "198",
      schedule_id: "47376",
      course_name: "零基础-爵士入门",
      coach_name: "Rima",
      course_size: "35",
      occupied: "4",
      remain_num: "31",
      start: "13:50",
      end: "14:50",
      classroom: "落地窗大教室A",
      course_diff_level: "1",
      coach_avatar: "https://img.keepyoga.com/1789813290_5614_pic.jpg@q_80,w_200,h_200",
    },
  ],
  // ③ 参数失效 / 场馆不存在 → errno≠0，必须跳过而不是抛错
  3: null,
};

const CONFIG = {
  id: "keepyoga-wushiba",
  mode: "keepyoga",
  studio: { name: "舞十八", city: "上海", region: "CN" },
  keepyoga: { baseUrl: "https://vcloud.keepyoga.com", brandId: BRAND_ID, venues: VENUES },
};

/* ─── 假 fetch ───────────────────────────────────────────────────────────── */

let calls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? String(init.body) : "";
  calls.push({ url: u, body, method: init.method || "GET" });
  const json = (b) => ({ ok: true, status: 200, json: async () => b });

  if (u.includes("/course/api/wxccourselist")) {
    const venueId = new URLSearchParams(body).get("venue_id");
    const list = LIST_BY_VENUE[venueId];
    if (list === null) return json({ errno: 30, errmsg: "场馆未找到" });
    return json({ errno: 0, data: { list: list || [] } });
  }
  throw new Error("未预期的请求: " + u);
};

/* ─── 主流程 ─────────────────────────────────────────────────────────────── */

const BASE = new Date("2026-10-11T00:00:00Z");
const rows = await crawl(CONFIG, BASE);

check("3 家店都请求了（含当天没课/参数失效的那家）", calls.length, 3);
check(
  "⛔ API base 是根路径 /course/api/...（不是页面所在的 /weixin/...）",
  calls.every((c) => c.url === "https://vcloud.keepyoga.com/course/api/wxccourselist"),
  true,
);
check("用 POST 表单提交", calls.every((c) => c.method === "POST"), true);
check(
  "带上 brand_id + venue_id + date_str",
  calls[0].body.includes(`brand_id=${BRAND_ID}`) &&
    calls[0].body.includes("venue_id=1") &&
    calls[0].body.includes("date_str=2026-10-11"),
  true,
);

check("拿到的课：店1 三条（空课名那条被丢）+ 店2 一条", rows.length, 4);
check("门店档案 3 家（当天没课的那家也要留在库里）", rows.ensureStudios.length, 3);

const byName = (n) => rows.find((r) => r.courseName === n);

{
  const r = byName("基本功训练");
  check("店1 教练", r.coach, "dd");
  check("店1 时间", r.time, "15:00-16:00");
  check("店1 已约/容量（占用在前、容量在后）", r.capacity, "9/35");
  check("店1 capacity 解析出的容量", parseCapacity(r.capacity), 35);
  check("⭐ occupied 是已约（不是剩余 26）", r._bookedNum, 9);
  check("店1 status 可预约", r.status, "可预约");
  check("店1 难度 1 → BEGINNER", r._difficulty, "BEGINNER");
  check("店1 教室", r._roomName, "落地窗大教室A");
  check("店1 教练头像", r._coachAvatar, "https://img.keepyoga.com/1698912249_9427_pic.jpg@q_80,w_200,h_200");
  check("店1 门店名 = 品牌·分店", r._studioName, "舞十八·长宁古北");
  check("店1 城市", r._city, "上海");
}

{
  check("课名首尾的 '.' 被洗掉", byName("K-POP") !== undefined, true);
  const r = byName("K-POP");
  check("满员 → status 已满", r.status, "已满");
  check("满员已约 40", r._bookedNum, 40);
  check("难度 2 → INTERMEDIATE", r._difficulty, "INTERMEDIATE");
}

{
  const r = byName("URBAN");
  check("没有容量 → capacity 空串", r.capacity, "");
  check("没有已约 → bookedNum 是 null 不是 0", r._bookedNum, null);
  check("没见过的难度值 → 不标（交给课名规则）", r._difficulty, null);
  check("没有头像 → null", r._coachAvatar, null);
}

{
  const r = byName("零基础-爵士入门");
  check("店2 的门店名", r._studioName, "舞十八·静安星贸");
  check("店2 已约 4", r._bookedNum, 4);
}

check(
  "门店档案带电话",
  rows.ensureStudios.find((s) => s.name === "舞十八·普陀曹杨").contact,
  "17701845361",
);
check("门店档案的 id 顺序与配置一致（1/2/3）", rows.ensureStudios.map((s) => s.name), [
  "舞十八·长宁古北",
  "舞十八·静安星贸",
  "舞十八·普陀曹杨",
]);

/* ─── 参数缺失要能看见 ───────────────────────────────────────────────────── */

async function expectThrow(label, cfg) {
  let msg = "";
  try {
    await crawl(cfg, BASE);
  } catch (e) {
    msg = e.message;
  }
  const ok = msg.includes("keepyoga");
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? `  → "${msg}"` : `  期望抛「keepyoga…」，实得 ${JSON.stringify(msg)}`}`);
}

await expectThrow("缺 brandId → 抛错（不是静默空）", {
  ...CONFIG,
  keepyoga: { ...CONFIG.keepyoga, brandId: "" },
});
await expectThrow("缺 venues → 抛错", {
  ...CONFIG,
  keepyoga: { ...CONFIG.keepyoga, venues: [] },
});

/* ─── 入库：走真实 importer，验证「接过来」真的落到库里 ──────────────────── */

const { importSchedules } = await import("../server/src/crawler/importer.js");
const { prisma, __reset } = await import(new URL("./testing/fake-prisma-stub.mjs", import.meta.url));

__reset();
calls = [];
const live = await crawl(CONFIG, BASE);
// ⚠ `_date` 平时由 runCrawl 注入（rows.map(r => ({...r, _date: date}))），单测直调 importer 得自己补
const dated = (rs) => rs.map((r) => ({ ...r, _date: BASE }));
const res1 = await importSchedules(CONFIG, dated(live), live.ensureStudios);

check("首轮：4 节全部入库", res1.created["舞十八·长宁古北"] + res1.created["舞十八·静安星贸"], 4);
check("首轮：没有跳过", res1.skipped, 0);

const studios = await prisma.studio.findMany();
check("建了 3 家门店（有一家当天没课）", studios.length, 3);
check("门店名带品牌前缀", studios.map((s) => s.name).sort(), [
  "舞十八·普陀曹杨",
  "舞十八·静安星贸",
  "舞十八·长宁古北",
].sort());
check("门店电话入库", studios.find((s) => s.name === "舞十八·长宁古北").contact, "18321004204");

const scheds = await prisma.schedule.findMany();
check("课表 4 条", scheds.length, 4);
{
  const r = scheds.find((s) => s.courseName === "基本功训练");
  check("已约人数入库", r.bookedNum, 9);
  check("容量入库", r.capacity, 35);
  check("难度入库", r.difficulty, "BEGINNER");
  check("开始时间是北京 15:00", r.startTime.toISOString().slice(11, 16), "07:00");
  check("教室进了 remark", String(r.remark || "").includes("落地窗大教室A"), true);
}

// 幂等：第二轮不该重复建店/建课（容器每 6 小时跑一次，跑一次多一家店就是事故）
const res2 = await importSchedules(CONFIG, dated(await crawl(CONFIG, BASE)), live.ensureStudios);
check("重跑：created 全 0", (res2.created["舞十八·长宁古北"] || 0) + (res2.created["舞十八·静安星贸"] || 0), 0);
check("重跑：门店仍 3 家", (await prisma.studio.findMany()).length, 3);
check("重跑：课仍 4 条", (await prisma.schedule.findMany()).length, 4);

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
