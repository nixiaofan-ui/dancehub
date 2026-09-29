/**
 * 相对时间：「刚刚 / 12 分钟前 / 3 小时前 / 2 天前」。
 *
 * 只为一个用途服务：标出预约人数这份数据有多旧。
 * 人数是抓取快照，不标时间的话用户拿官方小程序一对，差几个数字
 * 只会觉得「你们不准」，看不出其实是「20 分钟前的数据」。
 *
 * @param {string} iso 服务端 ISO 时间（UTC）
 * @param {number} [now] 当前时间戳，便于测试
 * @returns {string} 空串表示拿不到时间（前端就该什么都不显示）
 */
function timeAgo(iso, now) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "";
  const diff = (now == null ? Date.now() : now) - t;
  if (diff < 60000) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + " 分钟前";
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + " 小时前";
  const day = Math.floor(hour / 24);
  if (day < 7) return day + " 天前";
  return "一周前";
}

module.exports = { timeAgo };
