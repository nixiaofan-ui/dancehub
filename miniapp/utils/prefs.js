/**
 * 界面「选择状态」的记忆。
 *
 * 起因是用户反馈：每次进小程序，课表页的门店/舞种筛选条、关注页的舞种筛选条
 * 和「按距离」开关、发现页的行政区筛选条，全都被重置成默认，要重新勾一遍。
 *
 * 这些状态原本只活在页面实例上（this.activeIds / this.activeStyles / this.activeDistricts），
 * 切 tab 时还在，小程序一被杀掉就没了 —— 所以落盘。
 *
 * ⚠ 三条纪律，每条都对应一次踩过的坑：
 *   1. 「没在筛」(null) 和「用户点过清除」([]) 是两件不同的事，必须分开存。
 *      混在一起 → 用户点「清除」后，下次加载又被全选回来（发现页出过）。
 *   2. 从存储读回来的勾选必须跟**当前可选项**对齐：门店下架、区名对不上、
 *      换了城市，都要自动剔掉。拿一份失效的旧勾选去筛新列表，
 *      结果就是整页空白，用户只会以为「这家店没收录」。
 *   3. 存储读写一律容错。存储坏了最多退回默认（全选），绝不能把页面打挂。
 *
 * 刻意不落盘的东西：
 *   - 定位坐标（在 utils/locate 的 GEO_KEY 里，30 分钟过期，那是距离排序的口径）；
 *   - 「按距离」的实际排序结果。只记用户**开关的意图**，坐标过期就不恢复 ——
 *     否则开关亮着、距离算不出来，列表顺序和按钮文案对不上。
 */

const KEY = {
  HOME: "dh_pref_home", // { cityId, stores, styles }
  FOLLOW: "dh_pref_follow", // { styles, near }
  DISCOVER: "dh_pref_discover", // { cityId, districts, near }
  TAB: "dh_pref_profile_tab", // "follows" | "coaches" | "mine" | "reminders"
};

function readDoc(key) {
  try {
    const v = wx.getStorageSync(key);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch (e) {
    /* ignore */
  }
  return null;
}

/**
 * 合并写。值为 null 表示「删掉这一项」（回到「没在筛」），
 * 传数组则是「存下用户的勾选」（空数组 = 用户清除了，也是有效状态）。
 */
function writeDoc(key, patch) {
  try {
    const cur = readDoc(key) || {};
    Object.keys(patch || {}).forEach((k) => {
      const v = patch[k];
      if (v === null) delete cur[k];
      else cur[k] = v;
    });
    if (Object.keys(cur).length) wx.setStorageSync(key, cur);
    else wx.removeStorageSync(key);
  } catch (e) {
    /* ignore */
  }
}

/**
 * 读一组勾选。
 * @returns {null|Array} null = 从没在这一项上筛过（调用方应全选）；
 *                       [] = 用户点过「清除」；[...] = 部分勾选
 * ⛔ 别把 null 归一成 []（纪律 1），两者在调用方是反着的两种行为。
 */
function readPicked(doc, field) {
  const v = doc ? doc[field] : null;
  if (!Array.isArray(v)) return null;
  // 存储里可能混进脏值（手工改过 / 老版本写的），只放行能当键用的
  return v.filter((x) => typeof x === "string" || typeof x === "number");
}

/**
 * 把「存下来的勾选」对齐到「当前可选项」，算出应该生效的勾选。
 *
 * @param {Array|null} saved     存储里读回来的（null = 从没筛过）
 * @param {Array} options        当前可选项（chips）
 * @param {(o:any)=>any} keyOf   从选项里取键
 * @returns {null|Array} null = 当没在筛（调用方全选）；[] = 保持「用户清除了」；
 *                       [...] = 部分勾选（已剔除失效项）
 *
 * ⚠ 「存的非空但全失效」→ 当没筛过（换了城市/门店全网下架）；
 *   「存的是空数组」→ 保持清除。这两条是纪律 1 + 2 的交点，改坏了就是
 *   「清除不生效」或「换城市后整页空白」。
 */
function alignPicked(saved, options, keyOf) {
  if (saved == null) return null;
  if (!saved.length) return []; // 用户清除过：不能被下一次加载全选回来
  const known = new Set((options || []).map(keyOf));
  const kept = saved.filter((k) => known.has(k));
  return kept.length ? kept : null;
}

/** 带 cityId 上下文的勾选：城市对不上就当从没筛过 */
function readScoped(cityId, key, field) {
  const doc = readDoc(key);
  if (!doc) return null;
  if (cityId != null && doc.cityId !== cityId) return null;
  return readPicked(doc, field);
}

function writeScoped(cityId, key, field, picked) {
  writeDoc(key, {
    cityId,
    [field]: Array.isArray(picked) ? picked.slice() : null,
  });
}

function readBool(key, field, dflt) {
  const doc = readDoc(key);
  return doc && typeof doc[field] === "boolean" ? doc[field] : !!dflt;
}

// ── 课表页 ──────────────────────────────────────────────

/** 已关注门店筛选。挂钩城市：换了城市这家店的课本来就不在列表里，旧勾选无意义 */
function readHomeStores(cityId) {
  return readScoped(cityId, KEY.HOME, "stores");
}

function writeHomeStores(cityId, ids) {
  writeScoped(cityId, KEY.HOME, "stores", ids);
}

/** 舞种筛选。不挂城市：舞种是全国统一口径（「爵士」到哪都是爵士） */
function readHomeStyles() {
  return readPicked(readDoc(KEY.HOME), "styles");
}

function writeHomeStyles(labels) {
  writeDoc(KEY.HOME, { styles: Array.isArray(labels) ? labels.slice() : null });
}

// ── 我的·关注 ────────────────────────────────────────────

function readFollowStyles() {
  return readPicked(readDoc(KEY.FOLLOW), "styles");
}

function writeFollowStyles(labels) {
  writeDoc(KEY.FOLLOW, { styles: Array.isArray(labels) ? labels.slice() : null });
}

/** 「按距离」的用户意图。⚠ 页面恢复它之前必须先确认坐标缓存还在（见文件头） */
function readFollowNear() {
  return readBool(KEY.FOLLOW, "near", false);
}

function writeFollowNear(on) {
  writeDoc(KEY.FOLLOW, { near: !!on });
}

/** 上次停在哪个 tab（关注 / 老师 / 我的课表 / 提醒设置） */
const TABS = ["follows", "coaches", "mine", "reminders"];

function readProfileTab() {
  const doc = readDoc(KEY.TAB);
  const t = doc && doc.tab;
  return TABS.indexOf(t) >= 0 ? t : "follows";
}

function writeProfileTab(tab) {
  if (TABS.indexOf(tab) < 0) return;
  writeDoc(KEY.TAB, { tab });
}

// ── 发现页 ──────────────────────────────────────────────

function readDiscoverDistricts(cityId) {
  return readScoped(cityId, KEY.DISCOVER, "districts");
}

function writeDiscoverDistricts(cityId, labels) {
  writeScoped(cityId, KEY.DISCOVER, "districts", labels);
}

function readDiscoverNear() {
  return readBool(KEY.DISCOVER, "near", false);
}

function writeDiscoverNear(on) {
  writeDoc(KEY.DISCOVER, { near: !!on });
}

module.exports = {
  alignPicked,
  readHomeStores,
  writeHomeStores,
  readHomeStyles,
  writeHomeStyles,
  readFollowStyles,
  writeFollowStyles,
  readFollowNear,
  writeFollowNear,
  readProfileTab,
  writeProfileTab,
  readDiscoverDistricts,
  writeDiscoverDistricts,
  readDiscoverNear,
  writeDiscoverNear,
};
