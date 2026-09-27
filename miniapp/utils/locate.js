/**
 * 城市级定位。
 *
 * 用 wx.getFuzzyLocation（模糊定位）而不是 wx.getLocation（精确定位）：
 *   1) 我们只需要「用户在哪个城市」，不需要门牌级精度，精确位置属于
 *      过度索取，审核和隐私指引都更麻烦；
 *   2) 精确定位只对部分类目开放（健身/运动类多半申请不下来），
 *      模糊定位的准入规则和 chooseLocation 一致，可自助开通；
 *   3) 二者在 app.json 的 requiredPrivateInfos 里互斥，只能选一个。
 *
 * 前置条件（少一样就会静默失败）：
 *   - app.json 声明 requiredPrivateInfos: ["getFuzzyLocation"]
 *   - 小程序后台「开发 → 开发管理 → 接口设置」自助开通模糊定位
 *   - 后台隐私指引勾选「位置信息」
 *
 * 用户拒绝过授权后 wx.getFuzzyLocation 不会再弹窗，只能引导去设置页，
 * 因此这里把「已拒绝」单独作为一种返回值暴露给 UI。
 */
const { apiLocateCity } = require("../services/api");

const SCOPE = "scope.userFuzzyLocation";
const CACHE_KEY = "dh_locate_cache";
const CACHE_TTL = 7 * 24 * 3600 * 1000; // 一周内不再反复定位

function readCache() {
  try {
    const c = wx.getStorageSync(CACHE_KEY);
    if (c && c.at && Date.now() - c.at < CACHE_TTL) return c;
  } catch (e) {
    /* ignore */
  }
  return null;
}

function writeCache(city) {
  try {
    wx.setStorageSync(CACHE_KEY, { cityId: city.id, at: Date.now() });
  } catch (e) {
    /* ignore */
  }
}

function getAuthState() {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (r) => {
        const a = (r && r.authSetting) || {};
        // true 已授权 / false 已拒绝 / undefined 从未询问
        resolve(a[SCOPE] === true ? "granted" : a[SCOPE] === false ? "denied" : "unknown");
      },
      fail: () => resolve("unknown"),
    });
  });
}

function getFuzzy() {
  return new Promise((resolve) => {
    if (typeof wx.getFuzzyLocation !== "function") {
      resolve({ err: "unsupported" });
      return;
    }
    wx.getFuzzyLocation({
      type: "gcj02", // 城市中心点表是 GCJ-02，别用 wgs84 否则整体偏移几百米
      success: (r) => resolve({ lat: r.latitude, lng: r.longitude }),
      fail: (e) => resolve({ err: (e && e.errMsg) || "fail" }),
    });
  });
}

/** 授权相关的拒绝/未声明，统一归一成 denied，让 UI 知道该引导去设置页 */
function isAuthError(msg) {
  return /auth|deny|denied|privacy|unauthorized|scope/i.test(String(msg || ""));
}

/**
 * 定位到城市。
 *
 * @param {object} opts
 * @param {boolean} opts.useCache 允许用一周内的缓存结果（后台静默定位用）
 * @returns {Promise<{code: string, city?: object, nearest?: array, msg?: string}>}
 *   code: ok | denied | unsupported | no-match | fail
 */
async function locateCity(opts) {
  const useCache = !!(opts && opts.useCache);
  const cities = (getApp().globalData.cities || []).filter((c) => c.region === "CN");
  if (!cities.length) return { code: "fail", msg: "城市列表还没加载完" };

  if (useCache) {
    const cached = readCache();
    if (cached) {
      const hit = cities.find((c) => c.id === cached.cityId);
      if (hit) return { code: "ok", city: hit, fromCache: true };
    }
  }

  const auth = await getAuthState();
  if (auth === "denied") return { code: "denied" };

  const loc = await getFuzzy();
  if (loc.err) {
    return {
      code: loc.err === "unsupported" ? "unsupported" : isAuthError(loc.err) ? "denied" : "fail",
      msg: loc.err,
    };
  }

  try {
    const r = await apiLocateCity(loc.lat, loc.lng);
    if (!r) return { code: "fail", msg: "定位服务无返回" };
    const hit = cities.find((c) => c.id === r.cityId);
    // matched=false：离最近的有课城市也太远（所在地还没接入），把候选给 UI 提示用
    if (!hit || !r.matched) {
      return { code: "no-match", nearest: r.nearest || [], msg: r.name };
    }
    writeCache(hit);
    return { code: "ok", city: hit, method: r.method, distanceKm: r.distanceKm };
  } catch (e) {
    return { code: "fail", msg: (e && e.message) || "定位失败" };
  }
}

/** 已拒绝授权时引导去设置页打开 */
function openSetting() {
  return new Promise((resolve) => {
    wx.openSetting({
      success: (r) => {
        const a = (r && r.authSetting) || {};
        resolve(a[SCOPE] === true ? "granted" : "denied");
      },
      fail: () => resolve("unknown"),
    });
  });
}

/**
 * 同步读缓存（供 app.init 在首屏渲染前就用上，避免先显示上海再跳到用户城市）。
 * @returns {{cityId: number, at: number}|null}
 */
function readLocateCache() {
  return readCache();
}

module.exports = { locateCity, openSetting, readLocateCache, LOCATE_SCOPE: SCOPE };
