/**
 * 常看的老师（爱师）。
 *
 * 与 utils/blocked.js 是同一套机制的反向偏好：那边是「别让我看见」，
 * 这边是「有他的课先给我看」。所以也照搬双份存储：
 * - 本地（Storage）：标记要立刻亮起来，等接口回来再变会显得卡
 * - 云端：换手机 / 重装小程序不至于从头再来
 *
 * 写操作「先本地后云端」，云端失败不影响本地生效。
 */

const KEY = "dh_fav_coaches";

function readCache() {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function writeCache(list) {
  try {
    wx.setStorageSync(KEY, list);
  } catch (e) {
    // 存储写满等极端情况，忽略即可：内存里的 list 仍然有效
  }
}

/** 标了哪些老师 */
function getFavCoaches() {
  return readCache();
}

/** 某个老师是不是爱师 */
function isFav(name, cache) {
  if (!name) return false;
  const list = cache || readCache();
  return list.indexOf(name) >= 0;
}

/** 标记一个老师，返回最新名单 */
function fav(name) {
  if (!name) return readCache();
  const list = readCache();
  if (list.indexOf(name) < 0) list.push(name);
  writeCache(list);
  return list;
}

/** 取消标记 */
function unfav(name) {
  const list = readCache().filter((n) => n !== name);
  writeCache(list);
  return list;
}

/**
 * 把服务端名单合并进本地。
 * 取并集而不是直接覆盖：服务端可能比本地旧（刚点关注还没同步成功），
 * 直接覆盖会让「我刚关注的人又消失了」。
 */
function mergeRemote(remote) {
  if (!Array.isArray(remote)) return readCache();
  const local = readCache();
  const merged = [...new Set(local.concat(remote))];
  writeCache(merged);
  return merged;
}

module.exports = { getFavCoaches, isFav, fav, unfav, mergeRemote, KEY };
