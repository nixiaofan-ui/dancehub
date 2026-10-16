/**
 * 「按距离」定位坐标口径的烟测（utils/locate.js）。
 *
 * 用户反馈原话：「[我的]-[按距离]显示，不随着定位改变，而是固定的」。
 * 查下来是 getOrigin 拿到缓存就直接返回 —— 30 分钟内无论人走到哪，
 * 点多少次开关都还是同一个坐标，列表顺序和「1-3km」这类分档当然纹丝不动。
 *
 * 现在的口径（四条，缺一条就会退回那个 bug）：
 *   ① 有用户动作（ask=true）→ **必定真定位**，缓存一律不吃；
 *   ② 没有用户动作（ask=false）→ 只读缓存，**绝不触发授权弹窗**；
 *   ③ 页面显示的静默校准（refreshOriginIfStale）→ 坐标放软了才定位，
 *      且**只有已授权**才去（没授权说明用户从没开过按距离，别平白弹框）；
 *   ④ 恢复「按距离」开关（readOriginCache）→ **不看坐标新旧**。开关是用户的
 *      意图，坐标新鲜度交给 ③。以前这里卡 30 分钟，导致开着的开关隔夜
 *      再进小程序会自己弹回去（用户原话「我明明开着」）。
 *
 *   /usr/local/bin/node tools/smoke-locate-origin.js
 */
const path = require("path");

const MINIAPP = path.resolve(__dirname, "..", "miniapp");

// ─── wx 桩 ──────────────────────────────────────────────────────────────
const store = new Map();
let authSetting = {}; // scope.userFuzzyLocation: true / false / undefined
let fuzzyResult = { lat: 31.2, lng: 121.4 };
let fuzzyFails = null; // 非空则 getFuzzyLocation 失败（errMsg）
let fuzzyCalls = 0;

global.wx = {
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ""),
  setStorageSync: (k, v) => store.set(k, v),
  removeStorageSync: (k) => store.delete(k),
  getSetting: ({ success }) => success({ authSetting }),
  getFuzzyLocation: ({ success, fail }) => {
    fuzzyCalls += 1;
    if (fuzzyFails) fail({ errMsg: fuzzyFails });
    else success({ latitude: fuzzyResult.lat, longitude: fuzzyResult.lng });
  },
};

const apiPath = require.resolve(path.join(MINIAPP, "services/api.js"));
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: { apiLocateCity: async () => ({ cityId: 1, matched: true }) },
};

const { getOrigin, refreshOriginIfStale, readOriginCache } = require(
  path.join(MINIAPP, "utils/locate.js"),
);
const { sortByDistance, llOf } = require(path.join(MINIAPP, "utils/geo.js"));

const GEO_KEY = "dh_geo_origin";
const SOFT_TTL = 3 * 60 * 1000;

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
function reset(originAgeMs) {
  store.clear();
  authSetting = {};
  fuzzyFails = null;
  fuzzyCalls = 0;
  if (originAgeMs != null) {
    store.set(GEO_KEY, { lat: 31.2, lng: 121.4, at: Date.now() - originAgeMs });
  }
}

(async () => {
  console.log("「按距离」定位坐标口径烟测");

  console.log("\n① 有用户动作 → 必定真定位，不吃缓存（就是这条修掉的 bug）");
  reset(60 * 1000); // 缓存很新鲜（1 分钟前）
  authSetting = { "scope.userFuzzyLocation": true };
  fuzzyResult = { lat: 30.5, lng: 114.3 }; // 人已经到武汉了
  let o = await getOrigin({ ask: true });
  check("确实调了定位（没被新鲜缓存挡住）", fuzzyCalls === 1, `calls=${fuzzyCalls}`);
  check("拿到的是**新**坐标", o && o.lat === 30.5 && o.lng === 114.3, JSON.stringify(o));
  check("新坐标写回了缓存", readOriginCache() && readOriginCache().lat === 30.5);

  console.log("\n② 没有用户动作 → 只读缓存，绝不弹授权框");
  reset(60 * 1000);
  authSetting = {}; // 从未授权
  o = await getOrigin();
  check("返回缓存坐标", o && o.lat === 31.2, JSON.stringify(o));
  check("一次定位都没调（不会弹授权框）", fuzzyCalls === 0, `calls=${fuzzyCalls}`);
  o = await getOrigin({ ask: false });
  check("显式 ask:false 同样不调", fuzzyCalls === 0, `calls=${fuzzyCalls}`);

  console.log("\n③ 没有用户动作 + 缓存过期 → 返回 null，仍然不弹框");
  reset(31 * 60 * 1000); // 超过 30 分钟硬过期
  o = await getOrigin();
  check("返回 null", o === null, JSON.stringify(o));
  check("没有偷偷去定位", fuzzyCalls === 0, `calls=${fuzzyCalls}`);

  console.log("\n④ 已拒绝授权 → 用户点了也不纠缠，直接 null");
  reset(60 * 1000);
  authSetting = { "scope.userFuzzyLocation": false };
  o = await getOrigin({ ask: true });
  check("返回 null", o === null, JSON.stringify(o));
  check("不去调定位（调了会反复失败）", fuzzyCalls === 0, `calls=${fuzzyCalls}`);

  console.log("\n⑤ 定位失败 → 静默 null，不抛错");
  reset(null);
  authSetting = { "scope.userFuzzyLocation": true };
  fuzzyFails = "getFuzzyLocation:fail auth deny";
  o = await getOrigin({ ask: true });
  check("返回 null", o === null, JSON.stringify(o));
  fuzzyFails = null;

  console.log("\n⑥ 静默校准：坐标新鲜就不打扰");
  reset(30 * 1000);
  authSetting = { "scope.userFuzzyLocation": true };
  fuzzyResult = { lat: 22.5, lng: 114.0 };
  o = await refreshOriginIfStale();
  check("返回 null（不用重排）", o === null, JSON.stringify(o));
  check("没调定位", fuzzyCalls === 0, `calls=${fuzzyCalls}`);

  console.log("\n⑦ 静默校准：坐标放软了就重新定位");
  reset(SOFT_TTL + 1000);
  authSetting = { "scope.userFuzzyLocation": true };
  fuzzyResult = { lat: 22.5, lng: 114.0 };
  o = await refreshOriginIfStale();
  check("调了定位", fuzzyCalls === 1, `calls=${fuzzyCalls}`);
  check("拿到新坐标", o && o.lat === 22.5, JSON.stringify(o));

  console.log("\n⑧ 静默校准：没授权过就不去弹框");
  reset(SOFT_TTL + 1000);
  authSetting = {}; // undefined = 从没问过
  o = await refreshOriginIfStale();
  check("返回 null", o === null, JSON.stringify(o));
  check("没调定位（否则会平白弹一个授权框）", fuzzyCalls === 0, `calls=${fuzzyCalls}`);

  console.log("\n⑨ 恢复开关：坐标旧了也照样恢复（这条让开关不再自己弹回去）");
  reset(31 * 60 * 1000); // 半小时前的坐标
  let stale = readOriginCache();
  check(
    "半小时前的坐标照样读得出来（开关能恢复，不自己弹回去）",
    stale && stale.lat === 31.2,
    JSON.stringify(stale),
  );
  reset(12 * 3600 * 1000); // 隔夜
  check("隔夜的坐标照样读得出来", !!readOriginCache());
  reset(null); // 缓存被清，从来没有过坐标
  check(
    "坐标真没有 → null（开关才不亮：亮着却算不出距离，文案会对不上）",
    readOriginCache() === null,
  );
  check("只读缓存，一次定位都没调（不会白弹授权框）", fuzzyCalls === 0, `calls=${fuzzyCalls}`);

  console.log("\n⑩ 端到端：坐标一变，关注列表顺序就该跟着变");
  const shops = [
    { id: "A", lat: 39.9, lng: 116.4 }, // 北京
    { id: "B", lat: 31.2, lng: 121.47 }, // 上海
    { id: "C", lat: 22.54, lng: 114.06 }, // 深圳
  ];
  const inShanghai = sortByDistance(shops, { lat: 31.23, lng: 121.47 }, llOf);
  const inShenzhen = sortByDistance(shops, { lat: 22.55, lng: 114.05 }, llOf);
  check(
    "人在上海时上海店第一",
    inShanghai.list[0].id === "B",
    inShanghai.list.map((x) => x.id).join(","),
  );
  check(
    "人到了深圳 → 顺序真的翻了（不是固定不变）",
    inShenzhen.list[0].id === "C",
    inShenzhen.list.map((x) => x.id).join(","),
  );
  check(
    "分档也跟着变（同一家北京店：从上海看和从深圳看不在同一档）",
    inShanghai.list.find((x) => x.id === "A")._dist !==
      inShenzhen.list.find((x) => x.id === "A")._dist ||
      inShanghai.list.find((x) => x.id === "A")._km !==
        inShenzhen.list.find((x) => x.id === "A")._km,
  );

  console.log(`\n${fail ? `✖ ${fail} 项未通过` : "✔ 全部通过"}`);
  process.exit(fail ? 1 : 0);
})();
