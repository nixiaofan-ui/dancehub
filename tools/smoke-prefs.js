/**
 * 界面「选择状态」记忆的烟测（utils/prefs + 三个页面的接入）。
 *
 * 起因：用户反馈每次进小程序，课表页的门店/舞种筛选条、关注页的舞种筛选条、
 * 发现页的行政区筛选条、关注页停留的 tab 全被重置，得重新勾一遍。
 *
 * 三条最容易写错、也最容易在生产上挨骂的纪律，全部钉死在这里：
 *   1. 「没在筛」(null) 和「用户点了清除」([]) 必须分开 ——
 *      混在一起就是「点了清除，一重载又自己全选回来」（首页门店条老实现就是这个 bug）
 *   2. 存下来的勾选必须跟当前可选项对齐 ——
 *      全失效（换城市/门店下架）要当「没在筛」，否则整页被筛空且说不清原因
 *   3. 存储里是脏值时只能退回默认，绝不能让页面挂掉
 *
 *   /usr/local/bin/node tools/smoke-prefs.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

/** 内存存储：模拟真机 Storage 的读写语义（key 不存在时 getStorageSync 返回 ""） */
const store = new Map();
global.wx = new Proxy(
  {
    getStorageSync: (k) => (store.has(k) ? store.get(k) : ""),
    setStorageSync: (k, v) => store.set(k, v),
    removeStorageSync: (k) => store.delete(k),
    getSystemInfoSync: () => ({ windowHeight: 667, safeArea: { bottom: 647 } }),
    showToast: () => {},
    stopPullDownRefresh: () => {},
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

const fakeApp = {
  globalData: { region: "CN", cities: [], cityId: 1, dirty: 0 },
  setCity: () => {},
};
global.getApp = () => fakeApp;

const COURSES = [
  { id: 1, courseName: "进阶jazz（A教室）", startTime: "10:00", studio: { id: 101, short: "甲店", name: "甲店" } },
  { id: 2, courseName: "JAZZ基础", startTime: "11:00", studio: { id: 102, short: "乙店", name: "乙店" } },
  { id: 3, courseName: "Hiphop入门", startTime: "12:00", studio: { id: 101, short: "甲店", name: "甲店" } },
  { id: 4, courseName: "古典舞身韵", startTime: "13:00", studio: { id: 102, short: "乙店", name: "乙店" } },
];

const fakeApi = {
  ensureReady: async () => {},
  apiTimeline: async () => ({ items: COURSES }),
  apiFollows: async () => [],
  apiBookings: async () => [],
  apiReminders: async () => [],
  apiMyImports: async () => [],
  apiMyCities: async () => [],
  apiBlocked: async () => [],
  apiFavCoaches: async () => [],
  apiCityList: async () => [],
  apiStudios: async () => [],
  apiBrands: async () => [],
  apiFollowIds: async () => [],
};
const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

const prefs = require(path.join(MINIAPP, "utils/prefs.js"));

require(path.join(MINIAPP, "pages/index/index.js"));
const indexCfg = captured;
require(path.join(MINIAPP, "pages/profile/profile.js"));
const profileCfg = captured;
require(path.join(MINIAPP, "pages/discover/discover.js"));
const discoverCfg = captured;

function mkPage(cfg) {
  const page = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data));
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

const CHIPS = [{ id: 101 }, { id: 102 }];
const keyId = (c) => c.id;

console.log("\n[1] 「没在筛」和「用户清除了」是两种状态，不能合并");
check("从没存过 → null（调用方全选）", prefs.readHomeStores(1), null);
check("存过[] → 读回来还是[]（清除语义保住）", (prefs.writeHomeStores(1, []), prefs.readHomeStores(1)), []);
check("存过[101,102] → 原样读回", (prefs.writeHomeStores(1, [101, 102]), prefs.readHomeStores(1)), [101, 102]);
check("写 null → 回到「没在筛」", (prefs.writeHomeStores(1, null), prefs.readHomeStores(1)), null);

console.log("\n[2] 勾选要跟「当前可选项」对齐");
check("从未筛过 → null", prefs.alignPicked(null, CHIPS, keyId), null);
check("清除过 → 保持空", prefs.alignPicked([], CHIPS, keyId), []);
check("部分失效 → 只留还有效的", prefs.alignPicked([101, 999], CHIPS, keyId), [101]);
check("全失效（换城市/门店下架）→ 当没在筛", prefs.alignPicked([777, 888], CHIPS, keyId), null);

console.log("\n[3] 门店勾选挂钩城市，舞种不挂钩");
store.set("dh_pref_home", { cityId: 1, stores: [101], styles: ["Jazz"] });
check("城市对得上 → 读得出来", prefs.readHomeStores(1), [101]);
check("城市对不上 → 当作没筛过", prefs.readHomeStores(2), null);
check("舞种跨城市照旧（全国同一口径）", prefs.readHomeStyles(), ["Jazz"]);

console.log("\n[4] 脏数据只能退回默认，不能把页面打挂");
store.set("dh_pref_home", { cityId: 1, stores: "oops" });
check("字段类型不对 → null", prefs.readHomeStores(1), null);
store.set("dh_pref_home", { cityId: 1, stores: [101, null, {}, "102", 103] });
check("数组里的脏值被剔掉", prefs.readHomeStores(1), [101, "102", 103]);
store.set("dh_pref_home", "not-an-object");
check("整个存的是字符串 → null", prefs.readHomeStores(1), null);
store.delete("dh_pref_home");

console.log("\n[5] 「我的」页：上次停在哪就回哪");
check("默认停在「关注」", prefs.readProfileTab(), "follows");
prefs.writeProfileTab("mine");
check("写过之后读回 mine", prefs.readProfileTab(), "mine");
prefs.writeProfileTab("随便什么");
check("非法 tab 不覆盖（防止越界值把页面打空）", prefs.readProfileTab(), "mine");

console.log("\n[6] 首页：恢复上次的门店筛选");
const idx = mkPage(indexCfg);
idx.data.cityId = 1;
store.set("dh_pref_home", { cityId: 1, stores: [101] });
idx.activeIds = prefs.readHomeStores(1);
const base = COURSES.filter((i) => idx.isVisibleCoach(i));
idx.syncStoreChips(base);
check(
  "只剩上次勾的甲店",
  idx.data.storeChips.map((c) => `${c.short}${c.on ? "+" : "-"}`),
  ["甲店+", "乙店-"],
);

console.log("\n[7] 首页：点过「清除」之后，重载不能被全选回来");
idx.activeIds = [101, 102];
idx.syncStoreChips(base);
idx.tapAllStores();
check("清除后一家都不留", idx.activeIds, []);
check("清除被写进存储", store.get("dh_pref_home").stores, []);
idx.syncStoreChips(base); // 每次 load 都会跑
check("重载后仍是清除态", idx.activeIds, []);
check("课表也确实空了", idx.applyFilters(base).length, 0);

console.log("\n[8] 首页：换城市取该城市自己的记录（互不串味）");
idx.data.cityId = 2;
idx.syncStoreChips(base);
check("新城市没记录 → 回全选", idx.activeIds, [101, 102]);
idx.data.cityId = 1;
idx.syncStoreChips(base);
check("切回来 → 恢复这个城市那份（清除态）", idx.activeIds, []);

console.log("\n[9] 首页：舞种筛选落盘");
idx.data.cityId = 1;
idx.activeIds = null;
idx.syncStoreChips(base);
idx.syncStyleChips(base);
idx.tapStyleChip({ currentTarget: { dataset: { label: "Jazz" } } });
check("取消 Jazz 后落盘里没有 Jazz", (store.get("dh_pref_home").styles || []).indexOf("Jazz") < 0, true);
check("剩下的舞种还在", (store.get("dh_pref_home").styles || []).length > 0, true);

console.log("\n[10] 关注页：tab 与舞种筛选");
const pf = mkPage(profileCfg);
pf.switchTab({ currentTarget: { dataset: { tab: "mine" } } });
check("切 tab 会记住", store.get("dh_pref_profile_tab").tab, "mine");
pf.switchTab({ currentTarget: { dataset: { tab: "hacker" } } });
check("非法 tab 不写入", prefs.readProfileTab(), "mine");
pf.activeStyles = ["Jazz"];
pf.data.styleAllOn = true;
pf.tapAllStyles();
check("关注页清除舞种会落盘", store.get("dh_pref_follow").styles, []);

console.log("\n[11] 发现页：恢复行政区筛选 + 换城市不串味");
const STUDIOS = [
  { id: 1, name: "甲舞蹈", district: "海淀区" },
  { id: 2, name: "乙舞蹈", district: "朝阳区" },
  { id: 3, name: "丙舞蹈", district: null },
];
const dc = mkPage(discoverCfg);
dc.data.cityId = 1;
store.set("dh_pref_discover", { cityId: 1, districts: ["海淀区"] });
dc.activeDistricts = prefs.readDiscoverDistricts(1);
dc.syncDistrictChips(STUDIOS);
check(
  "只勾上次那个区",
  dc.data.districtChips.filter((c) => c.on).map((c) => c.label),
  ["海淀区"],
);
check("列表也确实按区筛了", dc.applyDistrictFilter(STUDIOS).map((s) => s.id), [1]);
dc.tapAllDistricts();
check("全选后落盘", store.get("dh_pref_discover").districts.length, 3);
dc.data.cityId = 2;
dc.syncDistrictChips(STUDIOS);
check("换城市 → 回全选（该城市没记录）", store.get("dh_pref_discover").cityId, 1);

console.log(`\n${failed ? `✖ ${failed} 项失败` : "✔ 全部通过"}`);
process.exit(failed ? 1 : 0);
