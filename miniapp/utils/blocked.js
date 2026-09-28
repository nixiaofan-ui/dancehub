/**
 * 不想看的老师（用户侧叫「屏蔽」，但我们不当社交功能做）。
 *
 * 为什么要本地一份、云端一份：
 * - 本地（Storage）：首屏过滤必须同步完成，等接口回来再过滤会闪一下
 * - 云端：换手机 / 重装小程序不至于从头再来
 *
 * 写操作「先本地后云端」。云端失败不影响本地生效 —— 屏蔽是纯偏好，
 * 不该因为它同步失败就把用户的操作吞回去。
 */

const KEY = "dh_blocked_coaches";

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

/** 屏蔽了哪些老师 */
function getBlocked() {
  return readCache();
}

/** 是否屏蔽了某个老师 */
function isBlocked(name, cache) {
  if (!name) return false;
  const list = cache || readCache();
  return list.indexOf(name) >= 0;
}

/** 屏蔽一个老师，返回最新名单 */
function block(name) {
  if (!name) return readCache();
  const list = readCache();
  if (list.indexOf(name) < 0) list.push(name);
  writeCache(list);
  return list;
}

/** 取消屏蔽 */
function unblock(name) {
  const list = readCache().filter((n) => n !== name);
  writeCache(list);
  return list;
}

/**
 * 把服务端提交的名单合并进本地。
 * 服务端是权威，但它可能比本地旧（比如刚点屏蔽还没同步成功），
 * 所以取并集而不是直接覆盖，避免出现「我刚屏蔽的人又冒出来」。
 */
function mergeRemote(remote) {
  if (!Array.isArray(remote)) return readCache();
  const local = readCache();
  const set = new Set(local.concat(remote));
  const merged = [...set];
  writeCache(merged);
  return merged;
}

module.exports = { getBlocked, isBlocked, block, unblock, mergeRemote, KEY };
