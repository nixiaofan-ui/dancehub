/**
 * 发现页搜索结果的「顺序 + 品牌范围」回归（pages/discover）。
 *
 * 覆盖三件用户反馈的事：
 *   1. 门店结果排在教练结果**之前**（反过来时，搜店名先看到一屏老师卡片）
 *   2. 搜索态只列**这次搜到**的连锁品牌 —— 早期实现沿用上一次全城那份品牌表，
 *      于是搜「Jazz」顶部挂着一排一家店都没命中的品牌，点进去全是别的分店
 *   3. 门店 0 命中但教练有命中时，不能说「搜了个寂寞」（教练块就在下面）
 *
 *   /usr/local/bin/node tools/smoke-discover-search-order.js
 */
const fs = require("fs");
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

// wx 存根：load() 结束会走 measureIndexBar，需要 createSelectorQuery 能串起来
const selQuery = {
  select: () => selQuery,
  selectAll: () => selQuery,
  selectViewport: () => selQuery,
  boundingClientRect: () => selQuery,
  scrollOffset: () => selQuery,
  exec: (cb) => {
    if (typeof cb === "function") cb([]);
  },
};
const wxStub = {
  createSelectorQuery: () => selQuery,
  pageScrollTo: () => {},
  getWindowInfo: () => ({ windowHeight: 800, statusBarHeight: 20 }),
};
global.wx = new Proxy(wxStub, { get: (t, k) => (k in t ? t[k] : () => undefined) });

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({
  globalData: { region: "CN", cities: [{ id: 14, name: "北京" }], cityId: 14 },
});
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

let studiosRes = [];
let brandRes = [];
let coachRes = null;
let brandCalls = 0;

const fakeApi = {
  ensureReady: async () => {},
  apiCityList: async () => [],
  apiStudios: async () => studiosRes,
  apiBrands: async () => {
    brandCalls++;
    return brandRes;
  },
  apiFollows: async () => [],
  apiCoachSearch: async () => coachRes,
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

/** 模拟一次「带关键词、已收窄到北京」的搜索 */
async function search(page, kw, studios, coaches) {
  studiosRes = studios;
  coachRes = coaches || null;
  page.data.keyword = kw;
  page.data.searchCityId = 14;
  page.data.cityId = 14;
  await page.load();
}

let failed = 0;
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${g}，期望 ${w}`}`);
}

const AB_BRANCH = (id, branch) => ({ id, name: "AB DANCE（" + branch + "）", initial: "A" });
const flatStudios = (page) =>
  (page.data.sections || []).reduce((n, s) => n + s.studios.length, 0);

(async () => {
  console.log("\n[1] 搜索态：品牌条只留这次命中的品牌，别家的连锁不许出现");
  {
    const page = makePage();
    brandCalls = 0;
    // 服务端那份全城品牌表里有个「YZ DANCE」，这次搜索一家都没命中
    brandRes = [
      { name: "YZ DANCE", storeCount: 5, stores: [{ id: 88, name: "YZ DANCE·A店", branch: "A店" }] },
    ];
    await search(page, "AB", [AB_BRANCH(1, "剧场店"), AB_BRANCH(2, "国际店"), { id: 3, name: "ZZ舞蹈", initial: "Z" }]);
    check("品牌条只命中 AB DANCE", page.data.brands.map((b) => b.name), ["AB DANCE"]);
    check("AB DANCE 只算这次搜到的 2 家分店", page.data.brands[0].storeCount, 2);
    check("没命中关键词的 YZ DANCE 不出现", page.data.brands.some((b) => b.name === "YZ DANCE"), false);
    check("搜索态根本不去拉全城品牌表", brandCalls, 0);
    // 点品牌卡进的是这次命中的分店，不是全部
    check("品牌行带的分店 id 只有命中的两家", page.data.brands[0].stores.map((s) => s.id).join(","), "1,2");
    check("列表里 AB DANCE 收成一行 + ZZ 单店", flatStudios(page), 2);
    check("品牌条副标题说实话", page.data.brandSub, "只看这次搜到的分店");
  }

  console.log("\n[2] 只命中一家分店的品牌：不成条、也不收行");
  {
    const page = makePage();
    brandRes = [];
    await search(page, "AB", [AB_BRANCH(1, "剧场店"), { id: 3, name: "ZZ舞蹈", initial: "Z" }]);
    check("不显示品牌条", page.data.brands.length, 0);
    check("两家店各自一行（不假装成连锁）", flatStudios(page), 2);
  }

  console.log("\n[3] 门店 0 命中、教练有命中：不说「搜了个寂寞」");
  {
    const page = makePage();
    await search(page, "雪霏", [], {
      groups: [
        {
          name: "雪霏",
          studioCount: 1,
          upcoming: 3,
          studios: [{ studioId: 9, short: "MAX POWER", nextDate: "2026-10-02" }],
        },
      ],
    });
    check("门店列表为空", page.data.sections.length, 0);
    check("教练结果在", page.data.coachGroups.length, 1);
    check("教练块说明为什么只有老师", page.data.coachTip, "没有匹配的舞室，以下是命中的教练");
  }

  console.log("\n[4] 门店与教练都有命中：教练块副标题回到默认说明");
  {
    const page = makePage();
    await search(page, "KEN", [AB_BRANCH(1, "剧场店"), AB_BRANCH(2, "国际店")], {
      groups: [{ name: "KEN", studioCount: 2, upcoming: 5, studios: [{ studioId: 1, short: "AB DANCE" }] }],
    });
    check("门店在", page.data.sections.length, 1);
    check("教练在", page.data.coachGroups.length, 1);
    check("副标题是默认那句", page.data.coachTip, "同名多店不合并，按门店自己判断");
  }

  console.log("\n[5] 浏览态（没关键词）：仍会退回服务端那份全城品牌表");
  {
    const page = makePage();
    brandCalls = 0;
    brandRes = [{ name: "YZ DANCE", storeCount: 5, stores: [{ id: 88, name: "YZ DANCE·A店", branch: "A店" }] }];
    studiosRes = [{ id: 3, name: "ZZ舞蹈", initial: "Z" }];
    coachRes = null;
    page.data.keyword = "";
    page.data.searchCityId = null;
    page.data.cityId = 14;
    await page.load();
    check("拉了一次全城品牌表", brandCalls, 1);
    check("品牌条用的是服务端结果", page.data.brands.map((b) => b.name), ["YZ DANCE"]);
    check("浏览态副标题还是「一次看完全部分店」", page.data.brandSub, "一次看完全部分店");
  }

  console.log("\n[6] 教练跳转条：点它不炸（真机上滚到教练块）");
  {
    const page = makePage();
    await search(page, "KEN", [AB_BRANCH(1, "剧场店"), AB_BRANCH(2, "国际店")], {
      groups: [{ name: "KEN", studioCount: 2, upcoming: 5, studios: [{ studioId: 1, short: "AB DANCE" }] }],
    });
    let threw = null;
    try {
      page.jumpToCoaches();
    } catch (e) {
      threw = e.message;
    }
    check("不抛错", threw, null);
  }

  console.log("\n[7] 版式顺序：门店在前、教练在后（改 WXML 顺序时这条会亮红）");
  {
    const wxml = fs.readFileSync(path.join(MINIAPP, "pages/discover/discover.wxml"), "utf8");
    const at = (cls) => wxml.indexOf('class="' + cls + '"');
    const jump = at("coach-jump");
    const list = at("studio-list");
    const coach = at("coach-block");
    check("三块都在", jump > 0 && list > 0 && coach > 0, true);
    check("教练跳转条在门店列表之前", jump < list, true);
    check("教练块在门店列表之后", coach > list, true);
    check("教练块有锚点 id（跳转要用）", wxml.indexOf('id="coach-block"') > 0, true);
    // 空态必须把「有教练命中」排除掉，否则会一边喊没搜到、一边列着教练；
    // 但「用户自己清除了行政区」要保留说明（那时门店列表是真的被筛空的）
    const emptyIdx = wxml.indexOf('class="empty"');
    const emptyCtx = emptyIdx > 0 ? wxml.slice(Math.max(0, emptyIdx - 300), emptyIdx) : "";
    check("空态条件里带上了 coachGroups", emptyCtx.indexOf("!coachGroups.length") > 0, true);
    check("空态条件里保留了 districtCleared 的例外", emptyCtx.indexOf("districtCleared") > 0, true);
    // 提报入口不能悬在教练结果上方（会让人以为搜索失败）
    const rrIdx = wxml.indexOf('class="report-row"');
    const rrCtx = rrIdx > 0 ? wxml.slice(Math.max(0, rrIdx - 200), rrIdx) : "";
    check("提报入口只在有门店结果时出现", rrCtx.indexOf("sections.length") > 0, true);
  }

  console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试崩了：", e);
  process.exit(1);
});
