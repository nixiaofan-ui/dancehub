/**
 * 「我的-关注」按距离 / 距离跟随定位的烟测（pages/profile）。
 *
 * 用户反馈原话：「分店距离在『我的』-『关注』界面不按照定位变化」。
 * 页面级的问题只有把 Page 抓下来跑才看得见 —— 看代码时每一步都「看起来对」，
 * 实际是三个洞一起造成的「距离固定」：
 *   ① 校准的软过期 3 分钟：回页面时还在用上车前的坐标；
 *   ② 定位一次失败就静默放弃：小程序刚恢复时定位模块常常没就绪；
 *   ③ 人没离开页面（onShow 不触发）时，压根没有任何东西去更新坐标。
 * 对应三条修复：软过期收到 90 秒、失败重试、开着开关时页面内 60 秒轮询。
 *
 * 另外补一条「必须说出来」：开关开着但定位真没跟上时，排序条上要出现
 * 「定位没更新 · 点此重试」，而不是让距离安静地停在旧值上。
 *
 *   /usr/local/bin/node tools/smoke-profile-near.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

// ─── 定时器桩（页面轮询是 60 秒一次，测试里手动触发） ────────────────────
const timers = [];
global.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return timers.length;
};
global.clearInterval = (id) => {
  if (id) timers[id - 1] = null;
};

// ─── wx 桩 ──────────────────────────────────────────────────────────────
const store = new Map();
let authSetting = { "scope.userFuzzyLocation": true };
let fuzzy = { lat: 39.901, lng: 116.401 };
let fuzzyFails = null;
let fuzzyCalls = 0;

global.wx = new Proxy(
  {
    getStorageSync: (k) => (store.has(k) ? store.get(k) : ""),
    setStorageSync: (k, v) => store.set(k, v),
    removeStorageSync: (k) => store.delete(k),
    getSetting: ({ success }) => success({ authSetting }),
    getFuzzyLocation: ({ success, fail }) => {
      fuzzyCalls += 1;
      if (fuzzyFails) fail({ errMsg: fuzzyFails });
      else success({ latitude: fuzzy.lat, longitude: fuzzy.lng });
    },
    showToast: ({ title }) => {
      global.__toast = title;
    },
    navigateTo: ({ url }) => {
      global.__lastUrl = url;
    },
    getWindowInfo: () => ({ windowHeight: 800, statusBarHeight: 20 }),
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({ globalData: { region: "CN", cities: [] } });
global.Component = () => {};
global.App = () => {};

// A 在原点旁、B 约 7km、C 约 13km、D 没坐标
const FOLLOWS = [
  { id: 1, studio: { id: 11, name: "A 店", city: "北京", platform: "IWOD", styles: [], lat: 39.9, lng: 116.4 } },
  { id: 2, studio: { id: 12, name: "B 店", city: "北京", platform: "IWOD", styles: [], lat: 39.95, lng: 116.45 } },
  { id: 3, studio: { id: 13, name: "C 店", city: "北京", platform: "IWOD", styles: [], lat: 39.8, lng: 116.3 } },
  { id: 4, studio: { id: 14, name: "D 店", city: "北京", platform: "IWOD", styles: [], lat: null, lng: null } },
];

const fakeApi = {
  ensureReady: async () => {},
  apiFollows: async () => FOLLOWS,
  apiBookings: async () => [],
  apiReminders: async () => [],
  apiMyImports: async () => [],
  apiMultiTimeline: async () => ({ items: [] }),
  apiBlocked: async () => [],
  apiFavCoaches: async () => [],
  apiMyCities: async () => [],
};
const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/profile/profile.js"));

function makePage() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch, cb) {
    for (const k of Object.keys(patch)) page.data[k] = patch[k];
    if (typeof cb === "function") cb();
  };
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const order = (page) => page.data.followsView.map((f) => f.studio.name).join(",");
const dist = (page, id) => {
  const row = page.data.followsView.find((f) => f.studio.id === id);
  return row ? row._dist : undefined;
};

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("  ✔ " + name);
  } else {
    fail += 1;
    console.log("  ✖ " + name + (extra ? " → " + extra : ""));
  }
}

const GEO_KEY = "dh_geo_origin";
function setGeo(ageMs, lat, lng) {
  store.set(GEO_KEY, { lat: lat == null ? 39.9 : lat, lng: lng == null ? 116.4 : lng, at: Date.now() - ageMs });
}

(async () => {
  console.log("「我的-关注」按距离跟随定位 烟测");

  // ── ① 没开开关：绝不碰定位 ───────────────────────────────────────────
  store.clear();
  timers.length = 0;
  fuzzyCalls = 0;
  const p1 = makePage();
  await p1.onLoad();
  p1.onShow();
  await sleep(60);
  check("没开开关时不调定位（不弹授权框）", fuzzyCalls === 0, `calls=${fuzzyCalls}`);
  check("没开开关就不显示距离", dist(p1, 11) === undefined || dist(p1, 11) === "", JSON.stringify(dist(p1, 11)));
  check("没开开关不起轮询", timers.filter(Boolean).length === 0, `timers=${timers.filter(Boolean).length}`);

  // ── ② 点开关 → 真定位 → 有距离、按距离排 ──────────────────────────────
  fuzzy = { lat: 39.901, lng: 116.401 };
  await p1.tapNearFirst();
  await sleep(30);
  check("开关打开了", p1.nearFirst === true);
  check("调了一次定位", fuzzyCalls === 1, `calls=${fuzzyCalls}`);
  check("顺序按距离：A 最近", order(p1) === "A 店,B 店,C 店,D 店", order(p1));
  check("A 店 <1km", dist(p1, 11) === "<1km", dist(p1, 11));
  check("没坐标的 D 排最后且不编距离", dist(p1, 14) === "" && p1.data.unknownCount === 1, JSON.stringify(dist(p1, 14)));
  check("开着开关才有轮询", timers.filter(Boolean).length === 1, `timers=${timers.filter(Boolean).length}`);

  // ── ③ 人挪到 C 附近，回页面 → 距离和顺序都跟着变 ─────────────────────
  fuzzy = { lat: 39.801, lng: 116.301 };
  setGeo(5 * 60 * 1000); // 上次坐标是 5 分钟前（超过 90 秒软过期）
  p1.onShow();
  await sleep(60);
  check("回页面后重新定位了", fuzzyCalls === 2, `calls=${fuzzyCalls}`);
  check("顺序真的翻了：C 第一", order(p1) === "C 店,A 店,B 店,D 店", order(p1));
  check("C 店变成 <1km", dist(p1, 13) === "<1km", dist(p1, 13));
  check("A 店从 <1km 变成 10-20km", dist(p1, 11) === "10-20km", dist(p1, 11));

  // ── ④ 页面没离开（onShow 不触发）→ 轮询也要跟着走 ────────────────────
  fuzzy = { lat: 39.951, lng: 116.451 }; // 挪到 B 附近
  const watch = timers.filter(Boolean).pop();
  check("轮询间隔 60 秒", watch && watch.ms === 60 * 1000, watch && watch.ms);
  await watch.fn();
  await sleep(60);
  check("轮询拿到了新坐标", fuzzyCalls === 3, `calls=${fuzzyCalls}`);
  check("页面没动，顺序也已经变成 B 第一", order(p1) === "B 店,A 店,C 店,D 店", order(p1));

  // ── ⑤ 在「我的课表」tab 时不白定位 ──────────────────────────────────
  p1.switchTab({ currentTarget: { dataset: { tab: "mine" } } });
  const before = fuzzyCalls;
  await timers.filter(Boolean).pop().fn();
  await sleep(30);
  check("不在关注 tab 时轮询不定位", fuzzyCalls === before, `calls=${fuzzyCalls}`);

  // ── ⑥ 定位失败 + 坐标很旧 → 必须出声 ────────────────────────────────
  p1.switchTab({ currentTarget: { dataset: { tab: "follows" } } });
  setGeo(30 * 60 * 1000);
  fuzzyFails = "getFuzzyLocation:fail system error";
  const beforeFail = fuzzyCalls;
  await p1.refreshNearOrigin();
  await sleep(900); // 内部会重试，等它跑完
  check("失败时确实重试了（不是一次就放弃）", fuzzyCalls - beforeFail >= 2, `calls=${fuzzyCalls - beforeFail}`);
  check("定位没跟上 → nearStale 亮起", p1.data.nearStale === true, String(p1.data.nearStale));
  check(
    "距离没被清空（开关仍是用户的意图，只是坐标旧）",
    p1.data.followsView.length === 4,
    order(p1),
  );

  // ── ⑦ 点「定位没更新」→ 强制定位 → 提示收起、距离更新 ────────────────
  fuzzyFails = null;
  fuzzy = { lat: 39.901, lng: 116.401 }; // 回到 A
  await p1.retryNear();
  await sleep(30);
  check("提示收起了", p1.data.nearStale === false, String(p1.data.nearStale));
  check("顺序回到 A 第一", order(p1) === "A 店,B 店,C 店,D 店", order(p1));

  // ── ⑧ 关开关 → 停轮询、清距离、清提示 ───────────────────────────────
  await p1.tapNearFirst();
  await sleep(20);
  check("开关关了", p1.nearFirst === false);
  check("轮询停了", timers.filter(Boolean).length === 0, `timers=${timers.filter(Boolean).length}`);
  check("关掉后不再显示距离", !dist(p1, 11), JSON.stringify(dist(p1, 11)));

  // ── ⑨ 页面隐藏 → 停轮询；再显示 → 恢复 ──────────────────────────────
  await p1.tapNearFirst();
  await sleep(20);
  check("重新打开后有轮询", timers.filter(Boolean).length === 1);
  p1.onHide();
  check("页面隐藏后轮询停掉", timers.filter(Boolean).length === 0, `timers=${timers.filter(Boolean).length}`);
  p1.onShow();
  await sleep(60);
  check("再回页面轮询恢复", timers.filter(Boolean).length === 1);

  console.log(`\n${fail ? `✖ ${fail} 项未通过` : "✔ 全部通过"}（${pass} 项）`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("测试崩了：", e);
  process.exit(1);
});
