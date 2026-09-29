/**
 * 品牌分店页（pages/studio/branches）逻辑烟测。
 *
 * 小程序页面没法在 Node 里真跑，这里把 Page() 捕获下来，手动喂假数据，
 * 验证「关注/全关注/今日课数/默认勾选」四条逻辑 —— 真机上才发现问题太贵。
 *
 * 关键手法：先用 require.cache 把 services/api.js 换成假实现，
 * 再 require 页面模块，页面里的 require("../../services/api") 就会命中假模块。
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");
global.wx = new Proxy(
  {
    getSystemInfoSync: () => ({ windowHeight: 667, safeArea: { bottom: 647 } }),
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
const appSingleton = { globalData: {} };
global.getApp = () => appSingleton;
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

// ── 假 API ──
const calls = { follow: [], unfollow: [], detail: [], timeline: [] };
const fakeApi = {
  ensureReady: async () => {},
  apiFollows: async () => [{ studio: { id: 2 } }],
  apiStudioDetail: async (id) => {
    calls.detail.push(id);
    return {
      id,
      name: `AB DANCE（第${id}店）`,
      city: { name: "杭州" },
      cityName: "杭州",
      address: "某某路 " + id + " 号",
    };
  },
  apiMultiTimeline: async (ids, from, to) => {
    calls.timeline.push(ids.join(","));
    return {
      items: [
        { id: 101, studio: { id: 1 } },
        { id: 102, studio: { id: 1 } },
        { id: 103, studio: { id: 3 } },
        { id: 104, studio: null }, // 脏数据：没有 studio 归属，不能让计数崩
      ],
    };
  },
  apiFollow: async (id) => calls.follow.push(id),
  apiUnfollow: async (id) => calls.unfollow.push(id),
};

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/studio/branches.js"));

function makePage() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) {
      if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
      page.data[k] = patch[k];
    }
  };
  page.selectComponent = () => null;
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
  // 场景 1：从多店课表页进来（手上只有 ids，页面会逐个问详情）
  const page = makePage();
  await page.onLoad({ ids: "1,2,3", name: "AB DANCE" });
  await new Promise((r) => setTimeout(r, 30));
  check("门店数", page.data.stores.length, 3);
  check("详情请求次数（无缓存时应逐个问）", calls.detail.length, 3);
  check("今日课数（脏数据不崩）", page.data.stores.map((s) => s.today), [2, 0, 1]);
  check("已关注来自 /follows", page.data.stores.map((s) => s.followed), [false, true, false]);
  check("已关注计数", page.data.followedCount, 1);
  check("全关注态", page.data.allFollowed, false);
  check("副标题", page.data.subtitle, "3 家分店");
  check("分店短名（剥掉品牌前缀）", page.data.stores[0].short, "第1店");

  // 场景 2：单行关注（乐观更新 + 真发请求）
  await page.toggleFollow({ currentTarget: { dataset: { id: "1" } } });
  check("点关注后行状态", page.data.stores[0].followed, true);
  check("真的发了 apiFollow", calls.follow, [1]);

  // 场景 3：全量关注（只补差的那两家）
  await page.toggleAll();
  check("全关注后", page.data.stores.map((s) => s.followed), [true, true, true]);
  check("全关注只补差的（1 已关注）", calls.follow, [1, 3]);
  check("全关注态翻转", page.data.allFollowed, true);

  // 场景 4：再点一次 = 全部取消
  await page.toggleAll();
  check("全部取消后", page.data.stores.map((s) => s.followed), [false, false, false]);
  check("取消请求打了 3 家", calls.unfollow, [1, 2, 3]);

  // 场景 5：合并看课表 —— 有已关注就默认勾它们
  await page.toggleFollow({ currentTarget: { dataset: { id: "2" } } });
  page.goAll();
  console.log("   跳转 URL:", global.__lastUrl);
  check("url 带已关注的分店", /&on=2$/.test(global.__lastUrl), true);

  // 场景 6：进单店
  page.goStore({ currentTarget: { dataset: { id: "3" } } });
  check("单店跳转", global.__lastUrl, "/pages/studio/weekly?id=3");

  // 场景 7：来源页塞了完整门店对象 → 不该再逐个问详情
  calls.detail.length = 0;
  appSingleton.globalData.brandStores = [{ id: 7, name: "X（A店）", cityName: "上海", address: "a" }];
  const page2 = makePage();
  await page2.onLoad({ ids: "7", name: "X" });
  await new Promise((r) => setTimeout(r, 30));
  check("有 globalData 缓存时不打详情接口", calls.detail.length, 0);
  check("仍会拉一次今日课数", calls.timeline.length >= 1, true);

  console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
  process.exit(failed ? 1 : 0);
})();
