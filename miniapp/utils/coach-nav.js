/**
 * 跳老师主页的统一入口。
 *
 * 为什么单独抽一个文件：课表页、课程详情页、门店周课表页三处都能点教练名，
 * 之前只有课表页绑了事件，另外两处点了没反应（看起来像坏了）。
 * 抽出来后三处行为一致，cityId 的兜底逻辑也只有一份。
 *
 * 注意：不要在模块顶层调用 getApp() —— app.js 还没跑完时它拿不到 globalData，
 * 而且历史上这种写法引发过「模块求值期抛错 → 所有页面不注册 → 白屏」。
 * 一律在函数内部取。
 */

/** cityId 兜底：优先用调用方给的，其次全局当前城市，最后本地缓存 */
function resolveCityId(cityId) {
  const n = Number(cityId);
  if (n > 0) return n;
  try {
    const a = typeof getApp === "function" ? getApp() : null;
    if (a && a.globalData && Number(a.globalData.cityId) > 0) {
      return Number(a.globalData.cityId);
    }
    const saved = Number(wx.getStorageSync("dh_cityId"));
    return saved > 0 ? saved : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 跳老师主页。
 * @param {string} name 教练名（"待定" 或空表示这节课没老师，不跳）
 * @param {number|string} [cityId] 城市 id，拿不到会自动兜底
 * @returns {boolean} 是否真的跳了（false = 无教练名）
 */
function goToCoach(name, cityId) {
  const coach = String(name || "").trim();
  if (!coach || coach === "待定") return false;
  const cid = resolveCityId(cityId);
  wx.navigateTo({
    url:
      "/pages/coach/index?name=" +
      encodeURIComponent(coach) +
      (cid ? "&cityId=" + cid : ""),
  });
  return true;
}

/**
 * 页面方法版，直接挂到 Page 上给 wxml 用：
 *   <view data-name="{{coachName}}" data-city-id="{{cityId}}" bindtap="goCoach">
 * dataset 里没有 cityId 时会走兜底（全局当前城市）。
 */
function onTapCoach(e) {
  const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
  return goToCoach(ds.name, ds.cityId);
}

module.exports = { goToCoach, onTapCoach, resolveCityId };
