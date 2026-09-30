/**
 * 发现页行政区筛选的烟测（pages/discover）。
 *
 * 覆盖两件容易写错的事：
 *   1. 「全选 / 清除」二合一：清除了就是一个区都不留，不是「不筛」
 *   2. 只有一个区（或一个都没有）时筛选条收起 —— 这时候必须当成**没在筛**，
 *      而不是「用户清除了」，否则同城列表会一家都不剩（线上真出过）
 *
 *   /usr/local/bin/node tools/smoke-discover-district.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");
global.wx = new Proxy(
  {},
  { get: () => () => undefined },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({ globalData: { region: "CN", cities: [], cityId: 1 } });
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

const fakeApi = {
  ensureReady: async () => {},
  apiCityList: async () => [],
  apiStudios: async () => [],
  apiBrands: async () => [],
  apiMyCities: async () => [],
  apiFollowIds: async () => [],
};

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/discover/discover.js"));

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

const countStudios = (page) =>
  (page.data.sections || []).reduce((n, s) => n + s.studios.length, 0);

const STUDIOS = [
  { id: 1, name: "甲舞蹈", district: "海淀区" },
  { id: 2, name: "乙舞蹈", district: "海淀区" },
  { id: 3, name: "丙舞蹈", district: "朝阳区" },
  { id: 4, name: "丁舞蹈", district: null },
];

function feed(page, studios) {
  page._studios = studios;
  page._brandList = [];
  page.data.globalMode = true; // 不做同城品牌合并，直接按店数断言
  page.syncDistrictChips(studios);
  page.setData(page.buildRows(page.applyDistrictFilter(studios)));
}

(async () => {
  const page = makePage();

  console.log("\n[1] 首次进入：全选，抽不到区的归「未标注」且默认带上");
  feed(page, STUDIOS);
  check("筛选条出现", page.data.showDistrictBar, true);
  check(
    "chip 与计数（按店数降序）",
    page.data.districtChips.map((c) => `${c.label}${c.count}`),
    ["海淀区2", "朝阳区1", "未标注1"],
  );
  check("按钮是全选态（显示「清除」）", page.data.districtAllOn, true);
  check("4 家都在", countStudios(page), 4);

  console.log("\n[2] 取消一个区 → 那区的店消失");
  page.tapDistrictChip({ currentTarget: { dataset: { label: "海淀区" } } });
  check("剩 2 家（朝阳 + 未标注）", countStudios(page), 2);
  check("按钮不再是全选态", page.data.districtAllOn, false);

  console.log("\n[3] 全选 / 清除 二合一：全选态下这颗按钮是「清除」");
  page.tapAllDistricts();
  check("恢复 4 家", countStudios(page), 4);
  page.tapAllDistricts();
  check("清除后一家不留", countStudios(page), 0);
  check("按钮回到「全选」", page.data.districtAllOn, false);
  check("空态标记为已清除", page.data.districtCleared, true);
  page.tapAllDistricts();
  check("再点回来 4 家", countStudios(page), 4);
  check("清除标记复位", page.data.districtCleared, false);

  console.log("\n[4] 只有一个区时筛选条收起 —— 这时候必须是「没在筛」");
  feed(page, [
    { id: 1, name: "甲舞蹈", district: "海淀区" },
    { id: 2, name: "乙舞蹈", district: "海淀区" },
  ]);
  check("不给筛选条", page.data.showDistrictBar, false);
  check("课照常出来（不能被当成清除）", countStudios(page), 2);

  console.log("\n[5] 一个区都没有时同理");
  feed(page, [
    { id: 1, name: "甲舞蹈", district: null },
    { id: 2, name: "乙舞蹈", district: null },
  ]);
  check("不给筛选条", page.data.showDistrictBar, false);
  check("课照常出来", countStudios(page), 2);

  console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试崩了：", e);
  process.exit(1);
});
