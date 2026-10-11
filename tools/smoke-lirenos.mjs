/**
 * 利刃 lirenos（K57 Dance Studio）引擎烟测 —— 假 fetch 回放真实响应，不连网。
 *
 *   cd server && /usr/local/bin/node ../tools/smoke-lirenos.mjs
 *
 * 为什么必须有：这平台的坑**全是「HTTP 200 + 空数据」型，一条错都不报** ——
 *   ⛔ 用错主机（lrydapi 而不是 club）→ 门店列表回 `{code:200,data:[]}`、
 *      company/query 回 `data:null`。看起来像「这家店就是没排课」，
 *      实际上是整个租户查不到。换主机立刻出数据。
 *   ⛔ 漏 `companyId` → 要么报「门店ID/公司ID不能为空」，要么落到别人家租户。
 *   ⛔ 课名取 `courseTitle`（恒为「常规课」）→ 全站课名长一个样，且不报错。
 *   ⛔ `mapPoint` 是「经度,纬度」，反了解析会落到几内亚湾而距离照样算得出来。
 *   ⚠ 地址带重复城市前缀（上海市上海市普陀区…）。
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
  message: "",
  data: [
    {
      companyId: 907,
      storeId: 998,
      storeName: "K57舞蹈工作室（曹杨路店）",
      cityName: "上海市",
      // ⚠ 真实的重复城市前缀
      address: "上海市上海市普陀区中山北路2790号杰地大厦404室",
      mapPoint: "121.41952514648438,31.241100041512844",
      phone: "13166102868",
    },
    {
      companyId: 907,
      storeId: 2557,
      storeName: "K57舞蹈工作室（徐家汇店）",
      cityName: "上海市",
      address: "上海市徐汇区2669号英雄大厦 2201室",
      mapPoint: "121.442154,31.186132",
      phone: "13166102868",
    },
    // 合成样本：上游偶发把经纬度写反，必须靠范围校验兜住（否则全落到几内亚湾）
    {
      companyId: 907,
      storeId: 3001,
      storeName: "K57舞蹈工作室（坐标写反店）",
      cityName: "上海市",
      address: "上海市静安区某路1号",
      mapPoint: "31.186132,121.442154",
      phone: "",
    },
    // 品牌旗下但没接入配置的店 → 它的课一律不落、店也不建
    {
      companyId: 907,
      storeId: 9999,
      storeName: "K57舞蹈工作室（暂不接入店）",
      cityName: "上海市",
      address: "上海市某处",
      mapPoint: "",
      phone: "",
    },
  ],
};

/** oneday 的响应是**门店数组**，课在每项的 timeScheduleList 里 */
const SCHEDULE = {
  code: 200,
  message: "",
  data: [
    {
      companyId: 907,
      storeId: 998,
      storeName: "K57舞蹈工作室（曹杨路店）",
      timeScheduleList: [
        // ① 常态：anotherName 才是课名，courseTitle 只是大类
        {
          teamScheduleId: 7406150,
          storeId: 998,
          courseTitle: "常规课",
          anotherName: "Jazz 基础",
          timeStartStr: "16:30",
          timeEndStr: "17:30",
          maxPeople: 20,
          appointCount: 5,
          venueName: "教室A",
          coachNameArrayStr: "彼得潘 ",
          coachInfoArray: [
            {
              coachId: 53229,
              coachName: "彼得潘",
              coachHeadImg:
                "https://save.image.liulianos.com.lirenos.com/1736601387663.png",
            },
          ],
          masterImg:
            "https://save.image.liulianos.com.lirenos.com/images/head_img/907/1.656748750133629E12.png",
          description: "课程为基础的爵士编舞，动作简单",
          statusChar: "未开课",
        },
        // ② 满员
        {
          teamScheduleId: 7406151,
          storeId: 998,
          courseTitle: "常规课",
          anotherName: "Kpop",
          timeStartStr: "18:50",
          timeEndStr: "19:50",
          maxPeople: 20,
          appointCount: 20,
          venueName: "教室A",
          coachNameArrayStr: "汤汤",
          coachInfoArray: [],
          masterImg: null,
        },
        // ③ 两个名字都空 → 整行丢弃
        {
          teamScheduleId: 7406152,
          storeId: 998,
          courseTitle: "   ",
          anotherName: "",
          timeStartStr: "10:00",
          timeEndStr: "11:00",
          maxPeople: 20,
          appointCount: 1,
        },
        // ④ 没有 anotherName → 退回 courseTitle；已约缺失 → null 不是 0
        {
          teamScheduleId: 7406153,
          storeId: 998,
          courseTitle: "常规课",
          anotherName: null,
          timeStartStr: "20:00",
          timeEndStr: "21:00",
          maxPeople: null,
          appointCount: null,
          venueName: "",
          coachNameArrayStr: "",
          coachInfoArray: null,
          masterImg: null,
        },
      ],
    },
  ],
};

const CONFIG = {
  id: "lirenos-k57",
  mode: "lirenos",
  studio: { name: "K57", city: "上海", region: "CN" },
  lirenos: {
    baseUrl: "https://club.lirenos.com",
    companyId: "907",
    storeIds: [998, 2557, 3001],
  },
};

/* ─── 假 fetch ───────────────────────────────────────────────────────────── */

let calls = [];
let scenario = "ok";

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, headers: init.headers || {} });
  const json = (b) => ({ ok: true, status: 200, json: async () => b });

  if (u.includes("store/all-store-name-list-nolimit")) {
    // 用错主机（lrydapi）时的真实症状：HTTP 200 + 空数组，零报错
    if (scenario === "emptyStores") return json({ code: 200, message: "", data: [] });
    return json(STORELIST);
  }
  if (u.includes("teamClass/teamSchedule/oneday")) {
    const sp = new URL(u).searchParams;
    const sid = sp.get("storeId");
    if (sid === "998") return json(SCHEDULE);
    // 其它门店：返回该店空课表（真实行为）
    return json({
      code: 200,
      message: "",
      data: [{ companyId: 907, storeId: Number(sid), storeName: "", timeScheduleList: [] }],
    });
  }
  throw new Error("未预期的请求: " + u);
};

/* ─── 主流程 ─────────────────────────────────────────────────────────────── */

const BASE = new Date("2026-10-11T00:00:00Z");
const rows = await crawl(CONFIG, BASE);

const schedCalls = calls.filter((c) => c.url.includes("teamSchedule/oneday"));

check(
  "⛔⛔ 主机是 club.lirenos.com（用 lrydapi 会静默返回空数据）",
  calls.every((c) => c.url.startsWith("https://club.lirenos.com/")),
  true,
);
check(
  "⛔ 每个请求都带 companyId=907（漏了就查不到租户）",
  calls.every((c) => c.url.includes("companyId=907")),
  true,
);
check(
  "⛔ 课表接口带 calendarStart + status（缺 calendarStart 报「请选择查询日期」）",
  schedCalls.every((c) => c.url.includes("calendarStart=2026-10-11") && c.url.includes("status=1,2,3")),
  true,
);
check(
  "按门店逐个请求（不传 storeId 报「门店ID/公司ID不能为空」）",
  schedCalls.length,
  3,
);
check(
  "门店接口只调 1 次（进程内缓存，不按天重复打）",
  calls.filter((c) => c.url.includes("all-store-name-list-nolimit")).length,
  1,
);

check("最终 3 条有效课（空课名丢 1 条）", rows.length, 3);
check("门店档案只建配置里列出的 3 家（9999 不在配置里 → 不建店）", rows.ensureStudios.length, 3);

const byName = (n) => rows.find((r) => r.courseName === n);

{
  const r = byName("Jazz 基础");
  check("⛔ 课名取 anotherName，不是 courseTitle「常规课」", r.courseName, "Jazz 基础");
  check("门店名带品牌（分店名已含 K57 → 不重复拼成 K57·K57…）", r._studioName, "K57舞蹈工作室（曹杨路店）");
  check("教练名去尾部空格", r.coach, "彼得潘");
  check("教练头像", r._coachAvatar, "https://save.image.liulianos.com.lirenos.com/1736601387663.png");
  check("时间用 timeStartStr/timeEndStr", r.time, "16:30-17:30");
  check("已约/容量", r.capacity, "5/20");
  check("capacity 解析", parseCapacity(r.capacity), 20);
  check("appointCount 是已约（实时直给）", r._bookedNum, 5);
  check("status 可预约", r.status, "可预约");
  check("教室", r._roomName, "教室A");
  check("⭐ masterImg 是课程图（38 节 16 张、多教练共用 → 不是教练图）", r._photoUrl, "https://save.image.liulianos.com.lirenos.com/images/head_img/907/1.656748750133629E12.png");
  check("⛔ 地址折掉重复城市前缀（上海市上海市 → 上海市）", r._address, "上海市普陀区中山北路2790号杰地大厦404室");
  check("⛔ mapPoint 是「经度,纬度」→ 经度 121.4", r._lng, 121.41952514648438);
  check("纬度 31.24", r._lat, 31.241100041512844);
  check("城市", r._city, "上海");
}

{
  const r = byName("Kpop");
  check("满员 → status 已满", r.status, "已满");
  check("满员已约 20", r._bookedNum, 20);
  check("没有教练头像数组 → null", r._coachAvatar, null);
}

{
  const r = byName("常规课");
  check("没有 anotherName → 退回 courseTitle 兜底", r.courseName, "常规课");
  check("没有容量 → capacity 空串", r.capacity, "");
  check("没有已约 → bookedNum 是 null 不是 0（0 和「不知道」是两回事）", r._bookedNum, null);
}

check(
  "未接入门店（9999）的课没有漏进来",
  rows.every((r) => !r._studioName.includes("暂不接入")),
  true,
);
check(
  "坐标写反的门店也被纠正（不是把纬度当经度）",
  rows.ensureStudios.find((s) => s.name.includes("坐标写反")).lng,
  121.442154,
);
check(
  "坐标缺失 → null，不编造",
  rows.every((r) => r._lng != null),
  true,
);

/* ─── 配置缺失 / 主机写错 要能看见 ──────────────────────────────────────── */

async function expectThrow(label, cfg, sc = "ok") {
  scenario = sc;
  let msg = "";
  try {
    await crawl(cfg, BASE);
  } catch (e) {
    msg = e.message;
  }
  scenario = "ok";
  const ok = msg.includes("利刃") || msg.includes("lirenos");
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? `  → "${msg}"` : `  期望抛错，实得 ${JSON.stringify(msg)}`}`);
}

await expectThrow("缺 companyId → 抛错（不是静默空）", {
  ...CONFIG,
  lirenos: { ...CONFIG.lirenos, companyId: "" },
});
await expectThrow("缺 storeIds → 抛错", {
  ...CONFIG,
  lirenos: { ...CONFIG.lirenos, storeIds: [] },
});
{
  // ⚠ 必须换 baseUrl：门店清单走**进程内缓存**，沿用 CONFIG.baseUrl 会直接命中
  //   上面成功那次留下的缓存 → 不发请求也不抛错，测试会假绿。（魔方烟测踩过同一个坑）
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.lirenos.baseUrl = "https://lrydapi.lirenos.com"; // 错误主机
  await expectThrow(
    "⛔⛔ 换错主机（lrydapi）→ 门店列表回空，必须抛出来而不是当成「没排课」",
    cfg,
    "emptyStores",
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

const totalCreated = Object.values(res1.created).reduce((a, b) => a + b, 0);
check("首轮：3 节全部入库", totalCreated, 3);
check("首轮：没有跳过", res1.skipped, 0);

const studios = await prisma.studio.findMany();
check("建了 3 家门店（9999 不在配置里）", studios.length, 3);
check(
  "地址入库（重复城市前缀已折掉）",
  studios.find((s) => s.name.includes("曹杨路")).address,
  "上海市普陀区中山北路2790号杰地大厦404室",
);

const coaches = await prisma.coach.findMany();
check("教练 2 位（彼得潘 / 汤汤；第 4 节的 coachNameArrayStr 是空串）", coaches.map((c) => c.name).sort(), ["彼得潘", "汤汤"].sort());
check(
  "⭐ 教练头像入库",
  coaches.find((c) => c.name === "彼得潘").avatarUrl,
  "https://save.image.liulianos.com.lirenos.com/1736601387663.png",
);
check("⛔ 门店电话绝不落库", JSON.stringify(studios).includes("13166102868"), false);

const scheds = await prisma.schedule.findMany();
check("课表 3 条", scheds.length, 3);
{
  const r = scheds.find((s) => s.courseName === "Jazz 基础");
  check("已约人数入库", r.bookedNum, 5);
  check("容量入库", r.capacity, 20);
  check("开始时间是北京 16:30", r.startTime.toISOString().slice(11, 16), "08:30");
  check("教室进了 remark", String(r.remark || "").includes("教室A"), true);
  check("课程图入库", r.coursePicUrl, "https://save.image.liulianos.com.lirenos.com/images/head_img/907/1.656748750133629E12.png");
}

// 幂等：第二轮不该重复建店/建课
const res2 = await importSchedules(CONFIG, dated(await crawl(CONFIG, BASE)), live.ensureStudios);
check("重跑：created 全 0", Object.values(res2.created).reduce((a, b) => a + b, 0), 0);
check("重跑：门店仍 3 家", (await prisma.studio.findMany()).length, 3);
check("重跑：课仍 3 条", (await prisma.schedule.findMany()).length, 3);
check("重跑：教练仍 2 位", (await prisma.coach.findMany()).length, 2);

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
