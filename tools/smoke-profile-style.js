/**
 * 我的-关注列表的舞种筛选烟测（pages/profile）。
 *
 * 这里筛的是**店**（一家店教 Jazz 也教 Kpop，选任一都该留下它），
 * 和首页「按课筛」是两套算法 —— 最容易写错的就是「一家店多舞种只算一票」，
 * 那会让计数和筛选结果同时失真，而界面上看不出来。
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

// A=Jazz  B=Jazz+Kpop  C=HipHop  D=没排课（归「其它」）  E=Kpop
const FOLLOWS = [
  { id: 1, studio: { id: 11, name: "A 舞室", city: "北京", platform: "IWOD", styles: ["Jazz"] } },
  { id: 2, studio: { id: 12, name: "B 舞室", city: "北京", platform: "IWOD", styles: ["Jazz", "Kpop"] } },
  { id: 3, studio: { id: 13, name: "C 舞室", city: "北京", platform: "IWOD", styles: ["HipHop"] } },
  { id: 4, studio: { id: 14, name: "D 舞室", city: "北京", platform: "IWOD", styles: [] } },
  { id: 5, studio: { id: 15, name: "E 舞室", city: "北京", platform: "IWOD", styles: ["Kpop"] } },
];

const fakeApi = {
  ensureReady: async () => {},
  apiFollows: async () => FOLLOWS,
  apiBookings: async () => [],
  apiReminders: async () => [],
  apiMyImports: async () => [],
  apiUnfollow: async () => {},
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

(async () => {
  const page = makePage();
  await page.loadAll();

  console.log("\n[1] 默认状态：全选，一家都不能少");
  check("关注全量", page.data.follows.length, 5);
  check("默认渲染 5 家", page.data.followsView.length, 5);
  check("筛选条出现", page.data.showStyleBar, true);
  check("「全部」是亮着的", page.data.styleAllOn, true);

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

  console.log("\n[4] 只留 Jazz → A 和 B 都在（B 是 Jazz+Kpop）");
  page.tapStyleChip({ currentTarget: { dataset: { label: "Kpop" } } });
  page.tapStyleChip({ currentTarget: { dataset: { label: "HipHop" } } });
  check("剩 2 家", page.data.followsView.length, 2);
  check(
    "留下的是 A、B",
    page.data.followsView.map((f) => f.studio.id).sort(),
    [11, 12],
  );

  console.log("\n[5] 点「全部」一键恢复");
  page.tapAllStyles();
  check("恢复 5 家", page.data.followsView.length, 5);
  check("全部亮着", page.data.styleAllOn, true);

  console.log("\n[6] 至少保留一个舞种（全关掉会变成「筛选了但什么都没筛」）");
  page.tapAllStyles();
  page.tapStyleChip({ currentTarget: { dataset: { label: "Kpop" } } });
  page.tapStyleChip({ currentTarget: { dataset: { label: "Jazz" } } });
  page.tapStyleChip({ currentTarget: { dataset: { label: "HipHop" } } });
  check("还剩「其它」一个", page.data.styleChips.filter((c) => c.on).length, 1);
  page.tapStyleChip({ currentTarget: { dataset: { label: "其它" } } });
  check("再点最后一个被拦住", page.data.styleChips.filter((c) => c.on).length, 1);
  check("有提示", global.__toast, "至少保留一个舞种");

  console.log("\n[7] 点卡片进门店课表");
  page.openStudio({ currentTarget: { dataset: { id: 12 } } });
  check("跳转地址", global.__lastUrl, "/pages/studio/weekly?id=12");

  console.log("\n[8] 卡片上的舞种速览（最多 3 个）");
  const mapped = page.data.follows.find((f) => f.studio.id === 12);
  check("B 店标签文案", mapped.styleText, "Jazz · Kpop");
  const noStyle = page.data.follows.find((f) => f.studio.id === 14);
  check("D 店没有标签（不显示空行）", noStyle.styleText, "");

  console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试崩了：", e);
  process.exit(1);
});
