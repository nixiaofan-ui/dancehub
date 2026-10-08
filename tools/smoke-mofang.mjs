/**
 * 魔方约课（saas.yqdicloud.com）引擎烟测 —— 假 fetch 回放真实响应，不连网。
 *
 *   cd server && /usr/local/bin/node ../tools/smoke-mofang.mjs
 *
 * 为什么必须有这个测试：魔方约课整条链路都是**猜出来的**，而猜错的代价全在细节里 ——
 *   ⚠ 参数名是 `time` 不是 `date`；传错会报 "Required request parameter 'time' ... is not present"，
 *     看上去像「接口不可用」，实际只是名字不对。
 *   ⚠ tenantId 必须走 **query**；放进 header 会被服务端以 500 挡掉（"数据错误"）。
 *   ⚠ `applyPeople` 是**已约**、`limitPeople` 是**容量** —— 和菲体云/styd 同向，
 *     和 iWOD 的 `remain`（已约/总）完全不同向，写反了整页人数都是错的。
 *   ⚠ `previewPoster` 字段名叫 poster，装的却是**课程预告片**（.mp4 直链，公开不过期）。
 *     它既不能当封面塞进 _photoUrl（每张卡都是裂图），也不该因为名字里有 poster 就丢掉 ——
 *     只有按扩展名分流（视频 → _videoRef、图片 → _photoUrl）才对。
 * 这几条都只在「跑起来」时才暴露，肉眼 review 看不出来，所以按行为断言。
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

/* ─── 真实响应 fixture（2026-09-30 实测抓下来，删减 description 等无关长字段） ─── */

const APP_PARAMS = {
  code: 200,
  msg: "操作成功",
  data: { tenantId: "978069", clientId: "0faf6127fd5efff894f835811980e5bd" },
};

const STORES = {
  code: 200,
  msg: "操作成功",
  data: [
    {
      id: "1894594512250070597",
      name: "11A DANCE",
      status: "1",
      img: "https://media.yqdicloud.com/2026/08/27/b7d85fdb3b2a45ea9c51b331959aeecb.jpg",
      address: "四川省成都市武侯区保利中心东区C座",
      longitude: "104.0719990",
      latitude: "30.6243250",
      phone: "13281222192",
      description: "11A DANCE舞蹈工作室",
    },
  ],
};

/** 课表行：一条一个「坑」 */
const ROWS = [
  // ① 常态：0 人约 / 容量 25 / 场地是 "-"（上游用连字符表示没场地）／海报是 mp4
  {
    id: "2107563547259744258",
    danceCourseName: "CHOREO",
    cateName: "团体课",
    teacherInfoName: "阿昊",
    teacherInfoPhoto: "https://media.yqdicloud.com/2026/08/27/a68d49dff94242e5bc58a35088a0d2ef.JPG",
    roomName: "-",
    startTime: "14:30",
    endTime: "15:50",
    scheduleDate: "2026-10-08",
    limitPeople: 25,
    applyPeople: 0,
    difficult: 4,
    status: "3",
    previewPoster: "https://media.yqdicloud.com/2026/10/07/aedc83a8e21c4e57948eba9e8f1369cc.mp4",
  },
  // ② 满员：已约 = 容量 → status 必须是「已满」，剩余必须是 0
  {
    id: "2107563547259744259",
    danceCourseName: "JAZZ入门",
    cateName: "团体课",
    teacherInfoName: "xinyu",
    teacherInfoPhoto: "https://media.yqdicloud.com/2026/08/27/2ee0cc62717242c9b877cb28fca27115.JPG",
    roomName: "大教室",
    startTime: "18:30",
    endTime: "19:50",
    scheduleDate: "2026-10-08",
    limitPeople: 25,
    applyPeople: 25,
    difficult: 2,
    status: "3",
    previewPoster: null,
  },
  // ③ 课名首尾带「.」装饰符 → 必须洗净（否则每次抓取都会跟库里已有行判重失败）
  {
    id: "2107563547259744260",
    danceCourseName: ".SWAG.",
    cateName: "团体课",
    teacherInfoName: "kk",
    teacherInfoPhoto: "https://media.yqdicloud.com/2026/08/27/74ec1e3e80804c0989893dfc247cb799.jpg",
    roomName: "-",
    startTime: "20:00",
    endTime: "21:20",
    scheduleDate: "2026-10-08",
    limitPeople: 50,
    applyPeople: 13,
    difficult: 0,
    status: "3",
    // 反向情形：字段名一样，但上游这次给的是真图片 → 该当封面（该平台本没有课程图）
    previewPoster: "https://media.yqdicloud.com/2026/10/07/b7d85fdb3b2a45ea9c51b331959aeecb.jpg",
  },
  // ④ 教练头像是上游的默认占位图 → 必须当「没有」（否则每张卡都是同一张灰脸）
  {
    id: "2107563547259744261",
    danceCourseName: "HIPHOP",
    cateName: "团体课",
    teacherInfoName: "待定",
    teacherInfoPhoto: "https://media.yqdicloud.com/default/customer/default.png",
    roomName: null,
    startTime: "19:00",
    endTime: "20:20",
    scheduleDate: "2026-10-08",
    limitPeople: 30,
    applyPeople: 5,
    difficult: 8,
    status: "3",
    // 脏数据：相对路径，既不是可播的视频也不是可渲染的封面 → 两处都必须丢掉
    previewPoster: "/static/upload/poster.png",
  },
  // ⑤ 没有容量、也没有已约（上游字段缺失）→ capacity "" / bookedNum 必须是 null 而不是 0
  {
    id: "2107563547259744262",
    danceCourseName: "URBAN",
    cateName: "团体课",
    teacherInfoName: "阿昊",
    teacherInfoPhoto: null,
    roomName: "-",
    startTime: "12:00",
    endTime: "13:20",
    scheduleDate: "2026-10-08",
    limitPeople: null,
    applyPeople: null,
    difficult: null,
    status: "3",
    previewPoster: null,
  },
  // ⑥ 空课名 → 整行丢弃
  {
    id: "2107563547259744263",
    danceCourseName: "   ",
    cateName: "团体课",
    teacherInfoName: "x",
    startTime: "09:00",
    endTime: "10:00",
    scheduleDate: "2026-10-08",
    limitPeople: 10,
    applyPeople: 1,
    difficult: 4,
    status: "3",
  },
];

const CONFIG = {
  id: "mofang-978069-11A-DANCE",
  mode: "mofang",
  studio: { name: "11A DANCE·保利中心店（武侯）", city: "成都", region: "CN" },
  mofang: {
    baseUrl: "https://saas.yqdicloud.com",
    appId: "wx2f6734758de0b8a6",
    tenantId: "978069",
    spanDays: 3,
  },
};

/* ─── 假 fetch ───────────────────────────────────────────────────────────── */

let calls = [];
let scenario = "ok";

globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const json = (body) => ({ ok: true, status: 200, json: async () => body });

  if (u.includes("/system/client/getAppParams")) {
    if (scenario === "badAppParams") return json({ code: 500, msg: "数据错误" });
    return json(APP_PARAMS);
  }
  if (u.includes("/dance/home/getStoreList")) {
    if (scenario === "noStores") return json({ code: 200, data: [] });
    return json(STORES);
  }
  if (u.includes("/dance/home/list")) {
    if (scenario === "badCode") return json({ code: 500, msg: "数据错误，请重新进入小程序查看" });
    // 只有第一天有课 —— 顺便验证「空课日不产生行」
    const time = new URL(u).searchParams.get("time");
    if (time !== "2026-10-08") return json({ code: 200, data: [] });
    return json({ code: 200, data: ROWS });
  }
  throw new Error("未预期的请求: " + u);
};

/* ─── 主流程 ─────────────────────────────────────────────────────────────── */

const BASE = new Date("2026-10-08T00:00:00+08:00");
const rows = await crawl(CONFIG, BASE);

check("只取到第一天的 5 条（空课名那行被丢）", rows.length, 5);
check(
  "课表请求数 = spanDays（3 天都要探，不能只抓今天）",
  calls.filter((u) => u.includes("/dance/home/list")).length,
  3,
);
check(
  "课表 URL 用 time= 参数（不是 date=）",
  calls.filter((u) => u.includes("/dance/home/list")).every((u) => u.includes("time=")),
  true,
);
check(
  "课表 URL 里没有 date=",
  calls.filter((u) => u.includes("/dance/home/list")).some((u) => u.includes("date=")),
  false,
);
check(
  "tenantId 在 query 里",
  calls.filter((u) => u.includes("/dance/home/list")).every((u) => u.includes("tenantId=978069")),
  true,
);

const byName = (n) => rows.find((r) => r.courseName === n);

// ① 常态
{
  const r = byName("CHOREO");
  check("① 课名", r.courseName, "CHOREO");
  check("① 教练", r.coach, "阿昊");
  check("① 时间", r.time, "14:30-15:50");
  check("① 剩余/容量（分母才是容量）", r.capacity, "25/25");
  check("① capacity 解析出的容量", parseCapacity(r.capacity), 25);
  check("① status 可预约", r.status, "可预约");
  check("① 已约人数", r._bookedNum, 0);
  check("① 难度 4 → INTERMEDIATE", r._difficulty, "INTERMEDIATE");
  check("① 场地 '-' 归一成空", r._roomName, "");
  check("⛔ ① previewPoster 是 .mp4 → 不得进 _photoUrl", r._photoUrl, null);
  check(
    "⭐ ① 但 mp4 要进 _videoRef（课程预告视频，公开不过期，可直接落库）",
    r._videoRef,
    "https://media.yqdicloud.com/2026/10/07/aedc83a8e21c4e57948eba9e8f1369cc.mp4",
  );
  check("① 预告直链长度 > VARCHAR(64) —— 这就是要加宽列的原因", r._videoRef.length > 64, true);
  check("① 教练头像保留", r._coachAvatar, "https://media.yqdicloud.com/2026/08/27/a68d49dff94242e5bc58a35088a0d2ef.JPG");
  check("① 门店名用配置里的（单店）", r._studioName, "11A DANCE·保利中心店（武侯）");
  check("① 排课日用上游 scheduleDate", r._scheduleDate, "2026-10-08");
}

// ② 满员
{
  const r = byName("JAZZ入门");
  check("② 剩余 0", r.capacity, "0/25");
  check("② status 已满", r.status, "已满");
  check("② 已约 25", r._bookedNum, 25);
  check("② 难度 2 → BEGINNER", r._difficulty, "BEGINNER");
  check("② 场地保留", r._roomName, "大教室");
  check("② 上游没给海报 → 封面/视频都空", [r._photoUrl, r._videoRef], [null, null]);
}

// ③ 课名清洗 + 同一个字段给了图片时的反向分流
check("③ 课名首尾的 '.' 被洗掉", byName("SWAG") !== undefined, true);
check("③ 难度 0（店家没设）→ 不标", byName("SWAG")._difficulty, null);
check("③ 已约 13", byName("SWAG")._bookedNum, 13);
check(
  "⭐ ③ previewPoster 给的是图片 → 当封面落 _photoUrl",
  byName("SWAG")._photoUrl,
  "https://media.yqdicloud.com/2026/10/07/b7d85fdb3b2a45ea9c51b331959aeecb.jpg",
);
check("③ 图片不得混进 _videoRef", byName("SWAG")._videoRef, null);

// ④ 占位头像 + 脏数据海报
check("④ 上游默认占位头像 → 当没有", byName("HIPHOP")._coachAvatar, null);
check("④ 难度 8 → ADVANCED", byName("HIPHOP")._difficulty, "ADVANCED");
check("④ 相对路径海报 → 不当封面", byName("HIPHOP")._photoUrl, null);
check("④ 相对路径海报 → 也不当视频（否则 <video> 会去加载一个 404）", byName("HIPHOP")._videoRef, null);

// ⑤ 字段缺失
{
  const r = byName("URBAN");
  check("⑤ 没有容量 → capacity 空串", r.capacity, "");
  check("⑤ 没有已约 → bookedNum 是 null 不是 0", r._bookedNum, null);
  check("⑤ status 仍给可预约", r.status, "可预约");
  check("⑤ 没有头像 → null", r._coachAvatar, null);
  check("⑤ 连 previewPoster 字段都没有 → 两处都 null（不是 undefined）", [r._photoUrl, r._videoRef], [null, null]);
}

// 门店档案
check("门店档案 1 条", rows.ensureStudios.length, 1);
{
  const s = rows.ensureStudios[0];
  check("门店名", s.name, "11A DANCE·保利中心店（武侯）");
  check("门店地址", s.address, "四川省成都市武侯区保利中心东区C座");
  check("门店坐标（纬度）", s.lat, 30.624325);
  check("门店坐标（经度）", s.lng, 104.071999);
  check("门店电话", s.contact, "13281222192");
}

/* ─── tenantId 可由 appId 换（配置没写 tenantId 时） ─────────────────────── */

calls = [];
{
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  delete cfg.mofang.tenantId;
  const rows2 = await crawl(cfg, BASE);
  check("不写 tenantId：先去换一次", calls.filter((u) => u.includes("getAppParams")).length, 1);
  check("换到 tenantId 后照常抓到课", rows2.length, 5);
}
{
  // 进程内缓存：同一个 appId 第二次不该再换
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  delete cfg.mofang.tenantId;
  await crawl(cfg, BASE);
  check("tenantId 结果走进程内缓存（第二次不再换）", calls.filter((u) => u.includes("getAppParams")).length, 1);
}

/* ─── 异常路径：报错要能看见，不能静默返回空 ─────────────────────────────── */

async function expectThrow(label, sc, cfg = CONFIG) {
  scenario = sc;
  let msg = "";
  try {
    await crawl(cfg, BASE);
  } catch (e) {
    msg = e.message;
  }
  scenario = "ok";
  const ok = msg.includes("魔方约课");
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? `  → "${msg}"` : `  期望抛「魔方约课…」，实得 ${JSON.stringify(msg)}`}`);
}

await expectThrow("课表接口 code≠200 → 抛错（不是静默空）", "badCode");
await expectThrow("门店列表为空 → 抛错", "noStores");
{
  // ⚠ 必须换一个 appId：tenantId 换算是**按 appId 缓存**的，
  //   沿用 CONFIG 的 appId 会直接命中上面成功那次留下的缓存 → 不请求也不抛错，
  //   测试会假绿。踩过一次。
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.mofang.appId = "wxBADAPPID0000000";
  delete cfg.mofang.tenantId;
  await expectThrow("appId 换不到 tenantId → 抛错（带上 appId 便于排查）", "badAppParams", cfg);
}

/* ─── 入库：走真实 importer，验证「接过来」真的落到库里 ──────────────────── */

const { importSchedules } = await import("../server/src/crawler/importer.js");
const { prisma, __reset } = await import(new URL("./testing/fake-prisma-stub.mjs", import.meta.url));

__reset();
calls = [];
const live = await crawl(CONFIG, BASE);
const res1 = await importSchedules(CONFIG, live, live.ensureStudios);

check("首轮：5 节全部入库", res1.created[CONFIG.studio.name], 5);
check("首轮：没有跳过", res1.skipped, 0);

const cities = await prisma.city.findMany();
check("建出了城市", cities.map((c) => c.name), ["成都"]);
check("城市 region", cities[0].region, "CN");

const studios = await prisma.studio.findMany();
check("建了 1 家门店", studios.length, 1);
check("门店名（带分店后缀）", studios[0].name, "11A DANCE·保利中心店（武侯）");
check("门店地址入库", studios[0].address, "四川省成都市武侯区保利中心东区C座");
check("门店坐标入库（上游是分开的 lat/lng，无换轴风险）", [studios[0].lat, studios[0].lng], [30.624325, 104.071999]);
check("门店电话入库", studios[0].contact, "13281222192");

const scheds = await prisma.schedule.findMany();
check("课表 5 条", scheds.length, 5);
{
  const jazz = scheds.find((s) => s.courseName === "JAZZ入门");
  check("已满课：容量", jazz.capacity, 25);
  check("已满课：已约人数", jazz.bookedNum, 25);
  check("已满课：难度", jazz.difficulty, "BEGINNER");
  check("已满课：开始时间是北京 18:30", jazz.startTime.toISOString().slice(11, 16), "10:30");
  const urban = scheds.find((s) => s.courseName === "URBAN");
  check("没给已约人数的课：存 null 不是 0", urban.bookedNum, null);
  check(
    "⛔ 没有任何 mp4 混进 coursePicUrl（封面列只放图片）",
    scheds.every((s) => !/\.(mp4|mov|webm)/i.test(String(s.coursePicUrl || ""))),
    true,
  );
  check(
    "⛔ 相对路径的脏海报两边都没进库",
    [
      scheds.find((s) => s.courseName === "HIPHOP").coursePicUrl,
      scheds.find((s) => s.courseName === "HIPHOP").videoRef,
    ],
    [null, null],
  );
  check(
    "图片海报进了 coursePicUrl（该平台本无课程图，白捡一张）",
    scheds.find((s) => s.courseName === "SWAG").coursePicUrl,
    "https://media.yqdicloud.com/2026/10/07/b7d85fdb3b2a45ea9c51b331959aeecb.jpg",
  );
  check(
    "⭐ 预告视频直链入库：videoRef 直接存 URL（公开不过期，无需回源）",
    scheds.find((s) => s.courseName === "CHOREO").videoRef,
    "https://media.yqdicloud.com/2026/10/07/aedc83a8e21c4e57948eba9e8f1369cc.mp4",
  );
  check("5 节课里只有 1 节带预告视频", scheds.filter((s) => s.videoRef).length, 1);
}

const coaches = await prisma.coach.findMany();
check("教练 4 位（阿昊/xinyu/kk/待定）", coaches.map((c) => c.name).sort(), ["kk", "xinyu", "待定", "阿昊"].sort());
check(
  "教练头像入库",
  coaches.find((c) => c.name === "阿昊").avatarUrl,
  "https://media.yqdicloud.com/2026/08/27/a68d49dff94242e5bc58a35088a0d2ef.JPG",
);
check("上游占位头像没入库", coaches.find((c) => c.name === "待定").avatarUrl, null);

// 幂等：第二轮不该重复建店/建课（容器每 6 小时跑一次，跑一次多一家店就是事故）
const res2 = await importSchedules(CONFIG, await crawl(CONFIG, BASE), live.ensureStudios);
check("重跑：created 0", res2.created[CONFIG.studio.name] || 0, 0);
check("重跑：updated 5", res2.updated[CONFIG.studio.name], 5);
check("重跑：门店仍 1 家", (await prisma.studio.findMany()).length, 1);
check("重跑：课仍 5 条", (await prisma.schedule.findMany()).length, 5);
check("重跑：教练仍 4 位", (await prisma.coach.findMany()).length, 4);

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
