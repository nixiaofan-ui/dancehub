/**
 * 我的-关注列表的舞种筛选烟测（pages/profile）。
 *
 * 这里筛的是**店**（一家店教 Jazz 也教 Kpop，选任一都该留下它），
 * 和首页「按课筛」是两套算法 —— 最容易写错的就是「一家店多舞种只算一票」，
 * 那会让计数和筛选结果同时失真，而界面上看不出来。
 *
 * 2026-09-30 加的两块：
 *   - 卡片内联课程：选完舞种要能看到「哪家店、什么时间有课」，只给门店等于没筛
 *   - 全选 / 清除 二合一：清除了就是一家不留，且重载后不能被悄悄全选回来
 *
 *   /usr/local/bin/node tools/smoke-profile-style.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");
global.wx = new Proxy(
  {
    navigateTo: ({ url }) => {
      global.__lastUrl = url;
    },
    showToast: ({ title }) => {
      global.__toast = title;
    },
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({ globalData: { region: "CN" } });
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

const { dateKey, todayKey, parseKey, addDays } = require(path.join(MINIAPP, "utils/date.js"));
const D1 = dateKey(addDays(parseKey(todayKey()), 1));
const D2 = dateKey(addDays(parseKey(todayKey()), 2));

// A=Jazz  B=Jazz+Kpop  C=HipHop  D=没排课（归「其它」）  E=Kpop
const FOLLOWS = [
  { id: 1, studio: { id: 11, name: "A 舞室", city: "北京", platform: "IWOD", styles: ["Jazz"] } },
  { id: 2, studio: { id: 12, name: "B 舞室", city: "北京", platform: "IWOD", styles: ["Jazz", "Kpop"] } },
  { id: 3, studio: { id: 13, name: "C 舞室", city: "北京", platform: "IWOD", styles: ["HipHop"] } },
  { id: 4, studio: { id: 14, name: "D 舞室", city: "北京", platform: "IWOD", styles: [] } },
  { id: 5, studio: { id: 15, name: "E 舞室", city: "北京", platform: "IWOD", styles: ["Kpop"] } },
];

// 未来一周的课：B 店故意给 5 节，测「卡片只铺 3 节 + 还有 N 节」
const COURSES = [
  { id: 101, studio: { id: 11 }, courseName: "Jazz 入门", startTime: "19:00", endTime: "20:30", scheduleDate: D1, coach: { name: "小明" } },
  { id: 102, studio: { id: 11 }, courseName: "Jazz 提高", startTime: "20:40", endTime: "22:00", scheduleDate: D2, coach: { name: "小明" } },
  { id: 201, studio: { id: 12 }, courseName: "Jazz 基础", startTime: "18:00", endTime: "19:30", scheduleDate: D1, coach: { name: "小红" } },
  { id: 202, studio: { id: 12 }, courseName: "Jazz 编舞", startTime: "19:40", endTime: "21:00", scheduleDate: D1, coach: { name: "小红" } },
  { id: 203, studio: { id: 12 }, courseName: "Jazz 进阶", startTime: "18:00", endTime: "19:30", scheduleDate: D2, coach: null },
  { id: 204, studio: { id: 12 }, courseName: "Jazz 强化", startTime: "19:40", endTime: "21:00", scheduleDate: D2, coach: null },
  { id: 205, studio: { id: 12 }, courseName: "Kpop 女团", startTime: "21:10", endTime: "22:30", scheduleDate: D1, coach: { name: "小蓝" } },
  { id: 301, studio: { id: 13 }, courseName: "HipHop 基础", startTime: "20:00", endTime: "21:30", scheduleDate: D1, coach: { name: "小绿" } },
  { id: 501, studio: { id: 15 }, courseName: "Kpop 男团", startTime: "20:00", endTime: "21:30", scheduleDate: D1, coach: { name: "小紫" } },
];

const fakeApi = {
  ensureReady: async () => {},
  apiFollows: async () => FOLLOWS,
  apiBookings: async () => [],
  apiReminders: async () => [],
  apiMyImports: async () => [],
  apiUnfollow: async () => {},
  apiMultiTimeline: async () => ({ items: COURSES }),
};

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/profile/profile.js"));

function makePage() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) {
      if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
      page.data[k] = patch[k];
    }
  };
  return page;
}

let failed = 0;
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${g}，期望 ${w}`}`);
}

const view = (page, id) => page.data.followsView.find((f) => f.studio.id === id);

(async () => {
  const page = makePage();
  await page.loadAll();

  console.log("\n[1] 默认状态：全选，一家都不能少（课表还没回来）");
  check("关注全量", page.data.follows.length, 5);
  check("默认渲染 5 家", page.data.followsView.length, 5);
  check("筛选条出现", page.data.showStyleBar, true);
  check("「全选」是亮着的", page.data.styleAllOn, true);

  console.log("\n[2] 计数按「店」算，一家店多舞种各投一票");
  // Kpop/Jazz 各 2 家（B 店两个舞种都算），HipHop 1 家，没排课的 D 归「其它」
  check(
    "chip 标签与计数（同数按舞种展示顺序）",
    page.data.styleChips.map((c) => `${c.label}${c.count}`),
    ["Kpop2", "Jazz2", "HipHop1", "其它1"],
  );

  console.log("\n[3] 取消勾选「其它」→ 没排课的那家被筛掉");
  page.tapStyleChip({ currentTarget: { dataset: { label: "其它" } } });
  check("剩 4 家", page.data.followsView.length, 4);
  check("被筛掉的是 D", page.data.followsView.some((f) => f.studio.id === 14), false);
  page.tapAllStyles();

  console.log("\n[4] 课表拉回来后：卡片内联这家店所选舞种的课");
  await page.loadFollowCourses(page.allFollows);
  check("A 店列出 2 节 Jazz", view(page, 11).courses.map((c) => c.id), [101, 102]);
  check("A 店没有「还有 N 节」", view(page, 11).moreCount, 0);
  check("B 店最多铺 3 节", view(page, 12).courses.length, 3);
  check("B 店还有 2 节没铺", view(page, 12).moreCount, 2);
  check("D 店没课就不铺（卡片保持原样）", view(page, 14).courses.length, 0);

  console.log("\n[5] 只留 Jazz：卡片里只剩 Jazz 的课");
  page.tapStyleChip({ currentTarget: { dataset: { label: "Kpop" } } });
  page.tapStyleChip({ currentTarget: { dataset: { label: "HipHop" } } });
  page.tapStyleChip({ currentTarget: { dataset: { label: "其它" } } });
  check("剩 A、B 两家", page.data.followsView.map((f) => f.studio.id), [11, 12]);
  check("A 店仍是那 2 节", view(page, 11).courses.map((c) => c.id), [101, 102]);
  check(
    "B 店只剩 Jazz（Kpop 那节被剔掉）",
    view(page, 12).courses.map((c) => c.id),
    [201, 202, 203],
  );
  check("B 店「还有 1 节」", view(page, 12).moreCount, 1);

  console.log("\n[6] 全选 / 清除 二合一：全选态下这颗按钮是「清除」");
  page.tapAllStyles(); // 先回到全选
  check("恢复 5 家", page.data.followsView.length, 5);
  page.tapAllStyles(); // 全选态 → 清除
  check("清除后一家不留", page.data.followsView.length, 0);
  check("按钮不再处于全选态（显示「全选」）", page.data.styleAllOn, false);
  check("空态标记为「被筛掉了」", page.data.emptyFiltered, true);
  check("空态标记 styleCleared", page.data.styleCleared, true);

  console.log("\n[7] 清除态不能被重载悄悄全选回来（onShow 每次都重拉）");
  await page.loadAll();
  check("还是 0 家", page.data.followsView.length, 0);
  check("按钮仍是「全选」", page.data.styleAllOn, false);
  page.tapAllStyles();
  check("点回来 5 家", page.data.followsView.length, 5);

  console.log("\n[8] 至少保留一个舞种（逐个取消到最后一个会被拦住）");
  page.tapStyleChip({ currentTarget: { dataset: { label: "Kpop" } } });
  page.tapStyleChip({ currentTarget: { dataset: { label: "Jazz" } } });
  page.tapStyleChip({ currentTarget: { dataset: { label: "HipHop" } } });
  check("还剩「其它」一个", page.data.styleChips.filter((c) => c.on).length, 1);
  page.tapStyleChip({ currentTarget: { dataset: { label: "其它" } } });
  check("再点最后一个被拦住", page.data.styleChips.filter((c) => c.on).length, 1);
  check("有提示", global.__toast, "至少保留一个舞种");

  console.log("\n[9] 跳转：卡片进门店课表，课行进课程详情");
  page.tapAllStyles();
  page.openStudio({ currentTarget: { dataset: { id: 12 } } });
  // 全选态不往 URL 上挂舞种：全选等于没筛，挂上去只是噪音
  check("全选态的门店跳转地址", global.__lastUrl, "/pages/studio/weekly?id=12");
  // 筛了才带：落点侧据此把筛选条预先勾好
  page.tapStyleChip({ currentTarget: { dataset: { label: "Kpop" } } });
  page.openStudio({ currentTarget: { dataset: { id: 12 } } });
  check(
    "筛过的门店跳转地址带上舞种",
    global.__lastUrl,
    "/pages/studio/weekly?id=12&style=" + encodeURIComponent("Jazz,HipHop,其它"),
  );
  page.tapAllStyles();
  page.openCourse({ currentTarget: { dataset: { id: 101 } } });
  check("课程跳转地址", global.__lastUrl, "/pages/course/detail?id=101");

  console.log("\n[10] 卡片上的舞种速览（有课表时按实际课程认，最多 3 个）");
  check("B 店标签文案", view(page, 12).styleText, "Jazz · Kpop");
  check("D 店没有标签（不显示空行）", view(page, 14).styleText, "");

  console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试崩了：", e);
  process.exit(1);
});
