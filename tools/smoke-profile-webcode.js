/**
 * 「我的 → 网页版登录码」烟测（pages/profile）。
 *
 * 这条链路是网页端登录的唯一入口，出错的表现都很安静：
 *   ① 码拿到却没起倒计时 → 用户以为「一直有效」，贴到电脑上早就过期；
 *   ② 倒计时到 0 没清掉码 → 界面上一直挂着一个必然失败的码；
 *   ③ 离开页面不停表 → 后台每秒 setData，白耗电；
 *   ④ 接口失败也把空码写进 data → 卡片展开成空白，看着像页面坏了。
 * 所以这里把 Page 抓下来真跑一遍，而不是只看代码。
 *
 *   /usr/local/bin/node tools/smoke-profile-webcode.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

// ─── 定时器桩：倒计时手动 tick，不真等 5 分钟 ───────────────────────────
const timers = [];
global.setInterval = (fn, ms) => {
  timers.push({ fn, ms, alive: true });
  return timers.length;
};
global.clearInterval = (id) => {
  if (id && timers[id - 1]) timers[id - 1].alive = false;
};
function tickSeconds(n) {
  for (let i = 0; i < n; i += 1) {
    for (const t of timers) if (t && t.alive) t.fn();
  }
}

// ─── wx 桩 ─────────────────────────────────────────────────────────────
const store = new Map();
let clipboard = null;
global.wx = new Proxy(
  {
    getStorageSync: (k) => (store.has(k) ? store.get(k) : ""),
    setStorageSync: (k, v) => store.set(k, v),
    removeStorageSync: (k) => store.delete(k),
    showToast: ({ title }) => {
      global.__toast = title;
    },
    setClipboardData: ({ data, success }) => {
      clipboard = data;
      if (success) success();
    },
    vibrateShort: () => {},
    getWindowInfo: () => ({ windowHeight: 800, statusBarHeight: 20 }),
    navigateTo: ({ url }) => {
      global.__lastUrl = url;
    },
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

// ─── api 桩：由每个用例决定返回什么 ────────────────────────────────────
let pairCodeImpl = async () => ({ code: "048213", ttlSeconds: 300 });
const fakeApi = {
  ensureReady: async () => {},
  apiPairCode: () => pairCodeImpl(),
  apiFollows: async () => [],
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

const reset = () => {
  timers.length = 0;
  global.__toast = "";
  clipboard = null;
  pairCodeImpl = async () => ({ code: "048213", ttlSeconds: 300 });
};

(async () => {
  console.log("「我的 → 网页版登录码」烟测");

  // ── ① 正常生成：码 + 倒计时 + 震动 ─────────────────────────────────
  reset();
  const p1 = makePage();
  await p1.onLoad();
  await p1.tapWebCode();
  check("拿到 6 位码", p1.data.webCode === "048213", p1.data.webCode);
  check("倒计时从 ttl 开始", p1.data.webCodeLeft === 300, String(p1.data.webCodeLeft));
  check("起了 1 秒间隔的表", timers.filter(Boolean).length === 1, `timers=${timers.length}`);
  check("忙碌标记已复位", p1.data.webCodeBusy === false, String(p1.data.webCodeBusy));

  // ── ② 倒计时到 0：码必须消失、表必须停 ──────────────────────────────
  tickSeconds(299);
  check("299 秒后还剩 1 秒", p1.data.webCodeLeft === 1, String(p1.data.webCodeLeft));
  check("此时码还在", p1.data.webCode === "048213", p1.data.webCode);
  tickSeconds(1);
  check("到 0 后码被清掉", p1.data.webCode === "", p1.data.webCode);
  check("到 0 后倒计时归零", p1.data.webCodeLeft === 0, String(p1.data.webCodeLeft));
  check("到 0 后表已停", timers.filter((t) => t && t.alive).length === 0, JSON.stringify(timers.length));

  // ── ③ 重复点击不会叠出两块表 ───────────────────────────────────────
  reset();
  const p2 = makePage();
  await p2.tapWebCode();
  await p2.tapWebCode();
  check("连点两次只留一块表", timers.filter((t) => t && t.alive).length === 1, `alive=${timers.filter((t) => t && t.alive).length}`);
  check("连点两次码仍只有 6 位", p2.data.webCode.length === 6, p2.data.webCode);

  // ── ④ 接口失败：不写空码、给提示 ───────────────────────────────────
  reset();
  pairCodeImpl = async () => {
    throw new Error("网络开小差了");
  };
  const p3 = makePage();
  await p3.tapWebCode();
  check("失败时不写空码（卡片不会展开成空白）", p3.data.webCode === "", JSON.stringify(p3.data.webCode));
  check("失败时不倒计时", p3.data.webCodeLeft === 0, String(p3.data.webCodeLeft));
  check("失败时有提示", String(global.__toast).includes("网络"), global.__toast);
  check("失败后忙碌标记复位", p3.data.webCodeBusy === false, String(p3.data.webCodeBusy));

  // ── ⑤ 返回的码不是 6 位数字：当成失败，不能把脏值贴到屏幕上 ────────
  reset();
  pairCodeImpl = async () => ({ code: "12ab", ttlSeconds: 300 });
  const p4 = makePage();
  await p4.tapWebCode();
  check("脏码不落到界面", p4.data.webCode === "", JSON.stringify(p4.data.webCode));
  check("脏码有提示", String(global.__toast).includes("登录码"), global.__toast);

  // ── ⑥ 复制 ─────────────────────────────────────────────────────────
  reset();
  const p5 = makePage();
  await p5.tapWebCode();
  p5.copyWebCode();
  check("复制的是那 6 位", clipboard === "048213", String(clipboard));
  check("复制有提示", String(global.__toast).includes("复制"), global.__toast);

  // ── ⑦ 收起 / 离开页面都要停表并清码 ───────────────────────────────
  reset();
  const p6 = makePage();
  await p6.tapWebCode();
  p6.hideWebCode();
  check("收起后码清空", p6.data.webCode === "", p6.data.webCode);
  check("收起后表已停", timers.filter((t) => t && t.alive).length === 0, `alive=${timers.filter((t) => t && t.alive).length}`);

  reset();
  const p7 = makePage();
  await p7.tapWebCode();
  p7.onHide();
  check("离开页面后码清空", p7.data.webCode === "", p7.data.webCode);
  check("离开页面后表已停", timers.filter((t) => t && t.alive).length === 0, `alive=${timers.filter((t) => t && t.alive).length}`);

  console.log(`\n${fail === 0 ? "✔ 全部通过" : "✖ 有失败"}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
