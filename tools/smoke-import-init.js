/**
 * 补录页 onLoad 的日期预填烟测。
 *
 * 这里踩过一次：`addDays(today, 13)` —— addDays 收的是 Date，而 todayKey()
 * 返回字符串 "2026-09-30"。onLoad 直接抛 `d.getTime is not a function`，
 * 后面那句 setData 根本不执行，用户从课表页点「＋」进来看到的是**空日期**。
 * 页面不白屏、也不报错，只是表单没填 —— 最难发现的那类。
 *
 *   /usr/local/bin/node tools/smoke-import-init.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

global.wx = new Proxy(
  {
    getStorageSync: () => "",
    setStorageSync: () => {},
    getSystemInfoSync: () => ({ windowHeight: 667, safeArea: { bottom: 647 } }),
  },
  { get: (t, p) => (p in t ? t[p] : () => undefined) },
);

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
global.getApp = () => ({ globalData: { cityId: 1, token: "t", cities: [] } });
global.Component = () => {};
global.App = () => {};
global.Behavior = (c) => c;

const fakeApi = {
  ensureReady: async () => {},
  apiCities: async () => [],
  apiLocateCity: async () => null,
};

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: fakeApi };

require(path.join(MINIAPP, "pages/import/import.js"));

let failed = 0;
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${g}，期望 ${w}`}`);
}

const page = Object.assign({}, captured);
page.data = JSON.parse(JSON.stringify(captured.data));
page.setData = function (patch) {
  for (const k of Object.keys(patch)) {
    if (/\./.test(k)) throw new Error("不支持路径式 setData: " + k);
    page.data[k] = patch[k];
  }
};

const { todayKey, parseKey, addDays, dateKey } = require(path.join(MINIAPP, "utils/date.js"));
const TODAY = todayKey();
const PLUS13 = dateKey(addDays(parseKey(TODAY), 13));

let threw = "";
try {
  page.onLoad({});
} catch (e) {
  threw = e.message;
}
check("onLoad 不抛错", threw, "");
check("起始日期 = 今天", page.data.dateStart, TODAY);
check("可选上限 = 今天 + 13 天（字符串，不是 Date）", page.data.dateEnd, PLUS13);
check("上限确实比今天晚（字符串比较可用）", page.data.dateEnd > page.data.dateStart, true);
check("日期框预填今天", page.data.dateText, TODAY);

// 从课表页带日期进来：早于今天的要被夹回今天
threw = "";
try {
  page.onLoad({ date: "2020-01-01" });
} catch (e) {
  threw = e.message;
}
check("带过期日期进来也不抛错", threw, "");
check("过期日期夹回今天", page.data.dateText, TODAY);

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
