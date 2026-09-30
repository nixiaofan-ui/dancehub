/**
 * 「我的-关注」筛了舞种 → 点门店卡片进门店课表，舞种筛选要跟过去。
 *
 * 用户在那儿筛了 Jazz，点进店却看到全部舞种，等于让他当着这家店的面再筛一次；
 * 而从卡片点进来的意图很明确：就想看这家店的 Jazz 什么时候有课。
 * 想看别的舞种，门店页的舞种条就在那儿。
 *
 * 盯六件事（后三件是这次最容易踩的坑）：
 *   1. 关注页跳转要把当前舞种拼进 URL；没在筛（null）/ 用户清除了（[]）都不带
 *   2. 门店页把 ?style= 解析成筛选条的初始勾选
 *   3. **带过来的舞种这家店一节都没有** → 回落全选，不能给一张全空课表
 *   4. **这家店只有一种舞种**（筛选条隐藏）→ 保持 null（没在筛），绝不能变成 []
 *      —— [] 是「用户清除」，filterByStyle 会把课一节不留地筛掉
 *   5. 预设只消费一次：用户自己点过之后，翻日期不能把他拽回去
 *   6. 没带 style 时默认行为不变（回归保护）
 *
 *   /usr/local/bin/node tools/smoke-style-carryover.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

const navs = [];
global.wx = new Proxy(
  {
    navigateTo: (o) => navs.push(o && o.url),
    switchTab: () => {},
    getStorageSync: () => "",
    setStorageSync: () => {},
    getSystemInfoSync: () => ({ windowWidth: 375, statusBarHeight: 20 }),
    createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }) }),
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;
global.getApp = () => ({ globalData: { cityId: 14, token: "t" } });

const fakeApi = {
  ensureReady: async () => {},
  apiFollows: async () => [],
  apiBookings: async () => [],
  apiSchedules: async () => [],
  apiWeekly: async () => ({ days: [] }),
  apiStudioDetail: async () => ({ id: 7, name: "测试舞室" }),
  apiTimelineMulti: async () => ({ days: [] }),
  // 单店课表：onLoad 会真拉一次，给空数据即可（这里只验舞种带过来的行为）
  apiStudioSchedules: async () => ({ days: [] }),
  // applyWeekData → refreshLiveNumbers 会回源刷预约人数；这里给空数就当拉不到
  apiStudioDayLive: async () => ({}),
};
for (const rel of ["services/api.js"]) {
  const p = require.resolve(path.join(MINIAPP, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: fakeApi };
}

// ── 先拿关注页（require 会覆盖 captured，所以一次拿一个）──
require(path.join(MINIAPP, "pages/profile/profile.js"));
const profilePage = captured;

// ── 再拿门店课表页 ──
require(path.join(MINIAPP, "pages/studio/weekly.js"));
const weeklyPage = captured;

function makePage(cfg) {
  const page = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) {
      if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
      page.data[k] = patch[k];
    }
  };
  // onLoad 会建的实例字段：不预置的话 applyWeekData 拿不到周锚点就炸
  page.weeksCache = {};
  page.bookedIds = new Set();
  page._liveFetched = {};
  page._styleLabels = undefined;
  page.weekMonday = new Date(2026, 8, 28); // 2026-09-28 周一
  page.data.selectedKey = "2026-10-01";
  page.data.weekDays = [];
  return page;
}

/** 造一份「某天有哪些课」的 grouped，键是日期 */
function groupedOf(rowsByDay) {
  const g = {};
  Object.keys(rowsByDay).forEach((k) => {
    g[k] = rowsByDay[k].map((n) => lesson(n));
  });
  return g;
}

/** 门店首页用的一节课（字段只给筛选逻辑要用的） */
const lesson = (courseName, studioId = 7) => ({
  id: courseName + studioId,
  studioId,
  courseName,
  coachName: "老师",
  startTime: "19:00",
  endTime: "20:00",
});

let failed = 0;
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${g}，期望 ${w}`}`);
}

(async () => {
  // ══════════ 一、关注页：跳转时把舞种带上 ══════════
  navs.length = 0;
  const prof = makePage(profilePage);
  prof.activeStyles = ["Jazz"];
  prof.openStudio({ currentTarget: { dataset: { id: 7 } } });
  check("筛了 Jazz → 门店页 URL 带 style", navs[0], "/pages/studio/weekly?id=7&style=Jazz");

  navs.length = 0;
  prof.activeStyles = ["Jazz", "Kpop"];
  prof.openStudio({ currentTarget: { dataset: { id: 9 } } });
  check(
    "筛了两个舞种 → 逗号分隔",
    navs[0],
    "/pages/studio/weekly?id=9&style=Jazz%2CKpop",
  );

  navs.length = 0;
  prof.activeStyles = null; // 没在筛
  prof.openStudio({ currentTarget: { dataset: { id: 7 } } });
  check("没在筛 → 不带 style（别给门店页塞无意义参数）", navs[0], "/pages/studio/weekly?id=7");

  navs.length = 0;
  prof.activeStyles = []; // 用户点了「清除」
  prof.openStudio({ currentTarget: { dataset: { id: 7 } } });
  check("清除了 → 也不带（他此刻什么都没选）", navs[0], "/pages/studio/weekly?id=7");

  navs.length = 0;
  prof.openStudio({ currentTarget: { dataset: {} } });
  check("没有 id 就不跳（脏数据不该白页）", navs.length, 0);

  // ══════════ 二、门店页：解析 ?style=（调真 onLoad，别测我抄的那份逻辑）══════════
  // 小程序路由会自动解一次 query，所以传进来的是 "Jazz,Kpop" 而不是 %2C 形式
  const wParse = makePage(weeklyPage);
  wParse.onLoad({ id: "7", style: "Jazz,Kpop" });
  check("onLoad 把 ?style 解析成预设", wParse._presetStyles, ["Jazz", "Kpop"]);
  check("预设存在时不会顺手把自己清掉", wParse._presetStyles.length, 2);
  await new Promise((r) => setTimeout(r, 30)); // 让 loadWeek 的 promise 落地，别留悬挂
  check("预设仍是待消费状态（首次同步时才消费）", wParse._presetStyles, ["Jazz", "Kpop"]);

  const wNoStyle = makePage(weeklyPage);
  wNoStyle.onLoad({ id: "7" });
  check("没带 style → 预设为 null", wNoStyle._presetStyles, null);

  const wBlank = makePage(weeklyPage);
  wBlank.onLoad({ id: "7", style: "" });
  check("空的 style 参数 → 也是 null（别留下 []）", wBlank._presetStyles, null);
  await new Promise((r) => setTimeout(r, 30));

  // ══════════ 三、首次同步：预设生效 + 只留该舞种的课 ══════════
  const w1 = makePage(weeklyPage);
  w1.studioId = 7;
  w1.multiMode = false;
  const grouped = {
    "2026-10-01": [lesson("Jazz 基础"), lesson("Kpop 进阶"), lesson("高跟鞋 Heels")],
    "2026-10-02": [lesson("Jazz Funk"), lesson("HipHop 初级")],
  };
  w1._presetStyles = ["Jazz"];
  w1.syncStyleChips(grouped);
  check("预设生效：只勾 Jazz", w1.activeStyles, ["Jazz"]);
  const chips1 = w1.data.styleChips.map((c) => [c.label, c.on]);
  check("筛选条上只有 Jazz 是选中的", chips1.filter((c) => c[1]).map((c) => c[0]), ["Jazz"]);
  check("筛选条显示了（有 4 种舞种）", w1.data.showStyleBar, true);
  check(
    "当天列表只剩 Jazz 的课",
    w1.visibleOf(grouped, "2026-10-01").map((i) => i.courseName),
    ["Jazz 基础"],
  );
  check("另一天同理", w1.visibleOf(grouped, "2026-10-02").map((i) => i.courseName), ["Jazz Funk"]);
  check("全选标记为假（只选了一个）", w1.data.styleAllOn, false);

  // ══════════ 四、预设只消费一次：用户改过之后翻日期不能被拽回来 ══════════
  w1.weeksCache["2026-09-28"] = grouped; // applyWeekData 从这里取当周数据
  w1.tapStyleChip({ currentTarget: { dataset: { label: "Kpop" } } }); // 用户自己加上 Kpop
  check("用户点后是两个舞种", w1.activeStyles.sort(), ["Jazz", "Kpop"]);
  w1.syncStyleChips(grouped); // 翻日期会再算一次
  check("再同步保持用户的选择，预设没复活", w1.activeStyles.sort(), ["Jazz", "Kpop"]);

  // ══════════ 五、带过来的舞种这家店一节都没有 → 回落全选，不能给全空 ══════════
  const w2 = makePage(weeklyPage);
  w2.studioId = 7;
  w2._presetStyles = ["Jazz"];
  const onlyOthers = {
    "2026-10-01": [lesson("Kpop 进阶"), lesson("HipHop 初级")],
  };
  w2.syncStyleChips(onlyOthers);
  check("没命中就全选，不是空数组", w2.data.styleAllOn, true);
  check("activeStyles 是全部舞种", w2.activeStyles.slice().sort(), ["HipHop", "Kpop"]);
  check(
    "课一节都没被筛掉",
    w2.visibleOf(onlyOthers, "2026-10-01").length,
    2,
  );

  // ══════════ 六、只有一种舞种（筛选条隐藏）→ 保持 null，绝不能是 [] ══════════
  const w3 = makePage(weeklyPage);
  w3.studioId = 7;
  w3._presetStyles = ["Jazz"];
  const singleStyle = { "2026-10-01": [lesson("HipHop 初级"), lesson("HipHop 进阶")] };
  w3.syncStyleChips(singleStyle);
  check("只有一种舞种 → 筛选条隐藏", w3.data.showStyleBar, false);
  check("activeStyles 保持 null（没在筛），不是 []", w3.activeStyles, null);
  check(
    "课全部保留（[] 会把这天筛光）",
    w3.visibleOf(singleStyle, "2026-10-01").length,
    2,
  );

  // ══════════ 七、回归：没带 style 时行为不变 ══════════
  const w4 = makePage(weeklyPage);
  w4.studioId = 7;
  w4._presetStyles = null;
  w4.syncStyleChips(grouped);
  check("没预设 → 默认全选", w4.data.styleAllOn, true);
  check(
    "默认能看到所有课",
    w4.visibleOf(grouped, "2026-10-01").length,
    3,
  );

  // 用户点「清除」后仍要保持空（本次改动不能破坏原有语义）
  w4.weeksCache["2026-09-28"] = grouped;
  w4.tapAllStyles();
  check("清除后 activeStyles 为 []", w4.activeStyles, []);
  check("清除后课全没了（这是用户的意思）", w4.visibleOf(grouped, "2026-10-01").length, 0);
  w4.syncStyleChips(grouped);
  check("清除态在重新同步后不被全选顶回来", w4.activeStyles, []);

  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
})();
