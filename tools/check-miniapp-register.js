#!/usr/bin/env node
/**
 * 小程序「注册体检」——在 Node 里用 mock 跑一遍所有模块的求值期代码。
 *
 * 为什么需要它：
 *   小程序的页面/组件注册（App()、Page()、Component()）都在模块顶层执行。
 *   只要被 require 的任何一个模块在求值期抛异常，注册链就断了，表现是：
 *     · 控制台一行 `Page "pages/index/index" has not been registered yet.`
 *     · 附带一个看不出文件名的堆栈（往往只指向 appservice.js:7）
 *     · 界面只剩一片背景色，没有报错页、没有请求日志
 *   2026-09-28 就被这个坑了半小时：services/api.js 里 apiSubscribeConfig
 *   只剩导出、丢了定义，module.exports 是顶层执行的，于是整个 api.js 求值失败，
 *   app.js 与所有页面一起注册失败。
 *   跑一遍这个脚本 2 秒就能定位，不用在开发者工具里猜。
 *
 * 用法：node tools/check-miniapp-register.js   （或 npm run check:register）
 * 退出码 0 = 全部模块求值成功且 App/Page/Component 均已注册。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MINIAPP = path.join(ROOT, "miniapp");
const APP_JSON = path.join(MINIAPP, "app.json");

// ─────────────────────────── 运行时 mock ───────────────────────────

const storage = Object.create(null);

const wxStub = {
  env: { USER_DATA_PATH: "/tmp" },
  getStorageSync: (k) => storage[k],
  setStorageSync: (k, v) => {
    storage[k] = v;
  },
  removeStorageSync: (k) => {
    delete storage[k];
  },
  getSystemInfoSync: () => ({
    platform: "devtools",
    system: "iOS 16.0",
    SDKVersion: "2.33.0",
    windowWidth: 375,
    windowHeight: 667,
    statusBarHeight: 20,
    safeArea: { top: 20, bottom: 647 },
  }),
  getDeviceInfo: () => ({ platform: "devtools" }),
  getAppBaseInfo: () => ({ SDKVersion: "2.33.0" }),
  getWindowInfo: () => ({
    windowWidth: 375,
    windowHeight: 667,
    statusBarHeight: 20,
    safeArea: { top: 20, bottom: 647 },
  }),
  cloud: { init: () => {}, callContainer: () => {} },
};

// 未显式 mock 的 wx.* 一律返回空函数，避免求值期因方法缺失而中断
const wx = new Proxy(wxStub, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return () => undefined;
  },
});

const registered = { app: null, pages: new Map(), components: new Map() };

function installGlobals() {
  global.wx = wx;
  global.App = (cfg) => {
    registered.app = cfg;
  };
  global.Page = (cfg) => {
    registered.pages.set(currentFile, cfg);
  };
  global.Component = (cfg) => {
    registered.components.set(currentFile, cfg);
  };
  global.Behavior = (cfg) => cfg;
  global.getApp = () => ({
    globalData: {},
    ready: Promise.resolve(),
    setCity() {},
  });
  global.requirePlugin = () => ({});
}

let currentFile = "";

// ─────────────────────────── 体检主流程 ───────────────────────────

function listJs(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "miniprogram_npm") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listJs(p, out);
    else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const failures = [];

installGlobals();

for (const file of listJs(MINIAPP)) {
  const rel = path.relative(MINIAPP, file).split(path.sep).join("/");
  currentFile = rel;
  try {
    require(file);
  } catch (e) {
    failures.push({
      rel,
      message: (e && e.message) || String(e),
      stack: String((e && e.stack) || "")
        .split("\n")
        .slice(1, 4)
        .map((l) => l.trim())
        .join("\n        "),
    });
  }
}

// ─────────────────────────── 结果校验 ───────────────────────────

const appJson = JSON.parse(fs.readFileSync(APP_JSON, "utf8"));
const declaredPages = appJson.pages || [];

const notRegistered = declaredPages.filter((p) => !registered.pages.has(p + ".js"));
const missingFiles = [];
for (const p of declaredPages) {
  for (const ext of [".js", ".json", ".wxml", ".wxss"]) {
    if (!fs.existsSync(path.join(MINIAPP, p + ext))) missingFiles.push(p + ext);
  }
}

const badPermission = Object.keys((appJson.permission || {})).filter(
  // permission 只认地理位置、录音、相册等少数 scope；写错了开发者工具会警告
  (k) =>
    ![
      "scope.userLocation",
      "scope.userFuzzyLocation",
      "scope.userLocationBackground",
      "scope.record",
      "scope.camera",
      "scope.bluetooth",
      "scope.writePhotosAlbum",
      "scope.addPhoneContact",
      "scope.addPhoneCalendar",
      "scope.werun",
      "scope.invoice",
      "scope.invoiceTitle",
      "scope.userInfo",
    ].includes(k),
);

// ─────────────────────────── 输出 ───────────────────────────

console.log(`检查范围：${listJs(MINIAPP).length} 个 .js 模块，${declaredPages.length} 个声明页面\n`);

if (failures.length) {
  console.log(`✖ ${failures.length} 个模块求值期抛异常（这会让 App/Page 注册失败 → 白屏）：\n`);
  for (const f of failures) {
    console.log(`  [${f.rel}]`);
    console.log(`    ${f.message}`);
    if (f.stack) console.log(`        ${f.stack}`);
    console.log("");
  }
} else {
  console.log("✔ 所有模块求值期无异常");
}

if (!registered.app) {
  console.log("✖ app.js 没有调用 App()（App 未注册 → 不会有 onLaunch/登录/请求）");
} else {
  console.log("✔ App() 已注册");
}

if (notRegistered.length) {
  for (const p of notRegistered) console.log(`✖ 页面未注册：${p}`);
} else {
  console.log(`✔ ${declaredPages.length} 个页面全部注册`);
}

if (missingFiles.length) {
  console.log(`✖ 页面四件套缺失：${missingFiles.join(", ")}`);
}

if (badPermission.length) {
  console.log(`✖ app.json permission 里有无效 scope（开发者工具会警告）：${badPermission.join(", ")}`);
}

const ok =
  !failures.length && !!registered.app && !notRegistered.length && !missingFiles.length && !badPermission.length;
console.log(ok ? "\n体检通过。" : "\n体检未通过，请修完再编译。");
process.exit(ok ? 0 : 1);
