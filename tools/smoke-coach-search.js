/**
 * 发现页「老师搜索结果」的视图构建烟测（pages/discover）。
 *
 * 服务端保证「同城同名全取、不合并」；这里保证前端把它**画对**：
 *   1. 同名多店要显式标出来（「同名 3 家店」），不能默认是一个人
 *   2. 每家店的排课状态分三档：有未来课 → 未来日期；只有历史 → 最近日期；都没有 → 暂无
 *   3. 门店清单超过 4 家收成 +N（卡片不能无限长）
 *   4. 同城搜不到时，全国兜底（crossCity）要能给出城市和位数
 *   5. 只要有关键词就要发教练请求 —— 发现页搜索默认全国（没有城市限定），
 *      写成 kw && scopeId 会让教练请求一次都不发
 *
 *   /usr/local/bin/node tools/smoke-coach-search.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");
global.wx = new Proxy({}, { get: () => () => undefined });

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({ globalData: { region: "CN", cities: [], cityId: 17 } });
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
  apiFollows: async () => [],
};

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/discover/discover.js"));

function makePage() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  // 城市表里放一个北京，标题上要显示「教练 · 北京」
  page.data.cities = [{ id: 17, name: "北京", region: "CN" }];
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

/** 服务端 /api/coaches/search 的典型返回：Ken 在 5 家店、Anna 只在 1 家 */
const RES = {
  keyword: "Ken",
  cityId: 17,
  groups: [
    {
      name: "Ken",
      avatarUrl: "https://cdn/ken.png",
      studioCount: 5,
      totalCourses: 40,
      upcoming: 6,
      nextDate: "2026-10-05",
      lastDate: "2026-09-28",
      multiStudio: true,
      studios: [
        { coachId: 1, studioId: 11, studioName: "甲舞蹈 三里屯店", short: "三里屯", upcoming: 3, past: 10, nextDate: "2026-10-02", lastDate: "2026-09-28" },
        { coachId: 2, studioId: 12, studioName: "乙舞蹈 朝阳店", short: "朝阳", upcoming: 3, past: 8, nextDate: "2026-10-05", lastDate: "2026-09-27" },
        { coachId: 3, studioId: 13, studioName: "丙舞蹈", short: "丙舞蹈", upcoming: 0, past: 5, nextDate: "", lastDate: "2026-09-20" },
        { coachId: 4, studioId: 14, studioName: "丁舞蹈", short: "丁舞蹈", upcoming: 0, past: 0, nextDate: "", lastDate: "" },
        { coachId: 5, studioId: 15, studioName: "戊舞蹈", short: "戊舞蹈", upcoming: 0, past: 2, nextDate: "", lastDate: "2026-09-10" },
      ],
    },
    {
      name: "Anna",
      avatarUrl: "",
      studioCount: 1,
      totalCourses: 4,
      upcoming: 0,
      nextDate: "",
      lastDate: "2026-09-22",
      multiStudio: false,
      studios: [
        { coachId: 9, studioId: 21, studioName: "己舞蹈", short: "己舞蹈", upcoming: 0, past: 4, nextDate: "", lastDate: "2026-09-22" },
      ],
    },
  ],
  total: 2,
};

const page = makePage();
const view = page.buildCoachGroups(RES, 17);
page.setData({ coachGroups: view.groups });

check("两组都出卡片", view.groups.length, 2);
check("标题带城市名", view.cityName, "北京");

const ken = view.groups[0];
check("头像透传", ken.avatarUrl, "https://cdn/ken.png");
check("同名多店要标出来", ken.multiStudio, true);
check("副标题：家数 + 近期课量", ken.sub, "5 家店 · 近期 6 节");
// ⚠ 门店 chip 只写店名、不写日期（日期挪到教练页），靠颜色区分能不能去上
check(
  "门店清单只铺 4 家，其余收成 +N",
  ken.studios.map((s) => s.short),
  ["三里屯", "朝阳", "丙舞蹈", "丁舞蹈"],
);
check(
  "用 hot 标出「近期有课」的店",
  ken.studios.map((s) => (s.hot ? "有课" : "历史")),
  ["有课", "有课", "历史", "历史"],
);
check("多余的 1 家收成 +1", ken.extraStudios, 1);

const anna = view.groups[1];
check("单店不标同名", anna.multiStudio, false);
check("只有历史课 → 副标题写历史", anna.sub, "己舞蹈 · 历史 4 节");
check("没有头像时给首字母占位", anna.initial, "A");

// 同城搜不到：服务端回 crossCity
const empty = page.buildCoachGroups(
  { keyword: "Zoe", cityId: 17, groups: [], total: 0, crossCity: { total: 3, cities: [{ cityId: 1, name: "上海", count: 2 }, { cityId: 2, name: "广州", count: 1 }] } },
  17,
);
check("同城 0 命中时不给卡片", empty.groups.length, 0);
check("全国兜底：位数", empty.crossCity.total, 3);
check("全国兜底：城市文案", empty.crossText, "上海 2 · 广州 1");

// 点卡片要跳到老师主页，且带这次搜索的城市（不是浏览城市）
page.data.cityId = 99;
global.__lastUrl = "";
global.wx = new Proxy(
  { navigateTo: ({ url }) => (global.__lastUrl = url) },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);
page.goCoachResult({ currentTarget: { dataset: { index: 0 } } });
check("点卡片跳老师主页（带搜索城市）", global.__lastUrl, "/pages/coach/index?name=Ken&cityId=17");

// 端到端：搜索时教练请求**必须**发出去。
// 发现页搜索默认是全国（searchCityId 为空），曾经写成 `kw && scopeId` 导致
// 教练请求一次都不发 —— 搜索框写着「搜索舞室 / 教练名称」，却永远只回门店。
(async () => {
  let calls = [];
  fakeApi.apiCoachSearch = async (q, cityId) => {
    calls.push([q, cityId]);
    return { keyword: q, cityId, nationwide: false, groups: [], total: 0 };
  };

  const p = makePage();
  p.data.keyword = "雪霏";
  p.data.cityId = 17;
  p.data.searchCityId = null; // 没点城市 chip = 全国搜
  await p.load();
  check("全国搜索也要发教练请求", calls, [["雪霏", 17]]);

  calls = [];
  p.data.searchCityId = 13; // 用户收窄到杭州
  await p.load();
  check("收窄城市后用收窄的城市", calls, [["雪霏", 13]]);

  // 全国兜底：同城 0 命中，服务端放宽到全国 → 卡片要标城市、跳转用组自己的城市
  const nat = {
    keyword: "雪霏",
    cityId: 17,
    nationwide: true,
    groups: [
      {
        name: "雪霏",
        avatarUrl: "",
        studioCount: 2,
        totalCourses: 9,
        upcoming: 3,
        nextDate: "2026-10-02",
        lastDate: "",
        multiStudio: true,
        cityNames: ["上海", "杭州"],
        cityId: 1,
        studios: [
          { studioId: 5, short: "陆家嘴", cityName: "上海", upcoming: 3, past: 0, nextDate: "2026-10-02", lastDate: "" },
          { studioId: 6, short: "杭州大厦", cityName: "杭州", upcoming: 0, past: 0, nextDate: "", lastDate: "" },
        ],
      },
    ],
    total: 1,
  };
  const nv = page.buildCoachGroups(nat, 17);
  check("全国兜底时标题写「全国」", nv.cityName, "全国");
  check("跨城卡片标出城市", nv.groups[0].cityLabel, "上海 / 杭州");
  check("门店 chip 带城市前缀", nv.groups[0].studios.map((s) => s.short), [
    "上海 · 陆家嘴",
    "杭州 · 杭州大厦",
  ]);
  global.__lastUrl = "";
  page.setData({ coachGroups: nv.groups });
  page.goCoachResult({ currentTarget: { dataset: { index: 0 } } });
  // 名字走 encodeURIComponent，比较前先解开
  check(
    "跨城卡片跳到老师所在城市（不是搜索城市）",
    decodeURIComponent(global.__lastUrl),
    "/pages/coach/index?name=雪霏&cityId=1",
  );

  console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
  process.exit(failed ? 1 : 0);
})();
