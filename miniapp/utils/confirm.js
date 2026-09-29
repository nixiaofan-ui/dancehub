/**
 * 二次确认弹窗： destructive 操作（取消预约、取消关注、关闭提醒）统一走这里。
 * 返回 Promise<boolean>，用 await 串在业务代码里，不用写一堆回调。
 *
 * ⚠ 坑：wx.showModal 只回调 success / fail，**用户点「取消」时也会进 success**
 * （r.confirm = false），只有系统级失败才进 fail。所以 fail 分支要 resolve(false)
 * 而不是 reject，否则页面会抛一个没人接的异常。
 */
function confirm({ title = "确认操作", content = "", confirmText = "确定", cancelText = "再想想" } = {}) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      confirmText,
      cancelText,
      confirmColor: "#e5484d",
      success: (r) => resolve(Boolean(r.confirm)),
      fail: () => resolve(false),
    });
  });
}

/**
 * 多选一（超过两个选项时用）。
 *
 * wx.showModal 只有「确定 / 取消」两个按钮，三岔口塞不进去 ——
 * 比如取消一节**自己录入**的课时，用户其实有三个去处：
 * 只取消预约 / 连课一起删 / 算了。硬压缩成「确定吗」等于替他做了决定。
 *
 * @param {string[]} itemList 最多 6 项（微信限制）
 * @param {string} [alert] 标题，放在列表上方
 * @returns 选中的**下标**；点了自带的「取消」返回 -1
 */
function choose({ itemList = [], alert = "" } = {}) {
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList,
      ...(alert ? { alert } : {}),
      success: (r) => resolve(r.tapIndex),
      // 点空白处/取消都走 fail，和 confirm 一样按「不选」处理，不要 reject
      fail: () => resolve(-1),
    });
  });
}

module.exports = { confirm, choose };
