const api = require("../services/api");
const { confirm } = require("./confirm");

/**
 * 预约一节课，撞课时先问一句。
 *
 * 服务端是权威：它查出时段相交的预约，回 409 + data.conflicts（哪节课、几点、
 * 哪家舞室）。前端拿这份数据拼弹窗 —— 只给一句「时间冲突」的话，用户还得自己
 * 去翻预约记录才知道撞了哪节。
 *
 * 用户坚持要约就带 force=true 重发一次：真有人会同时占两个位再挑一个，
 * 我们只负责提醒，不替他做决定。
 *
 * @returns 预约成功返回 booking；**用户看到冲突后主动放弃返回 null**（不是失败，
 *          调用方不该弹报错，也不该继续跳转）
 */
async function bookCourse(scheduleId, method, current) {
  let res;
  try {
    res = await api.apiCreateBooking(scheduleId, method);
  } catch (e) {
    const conflicts = e.body && e.body.data && e.body.data.conflicts;
    if (!conflicts || !conflicts.length) throw e;

    const c = conflicts[0];
    const cur = current || {};
    const when = cur.startTime && cur.endTime ? `${cur.startTime}-${cur.endTime}` : "";
    const where = c.studio ? `（${c.studio}）` : "";
    const yes = await confirm({
      title: "时间冲突",
      content:
        `「${cur.courseName || "这节课"}」${when}与已预约的「${c.courseName}」` +
        `${c.startTime}-${c.endTime}${where}时间重叠，同一时间上不了两节。仍要预约吗？`,
      confirmText: "仍要预约",
      cancelText: "算了",
    });
    if (!yes) return null;
    res = await api.apiCreateBooking(scheduleId, method, true);
  }
  return res;
}

module.exports = { bookCourse };
