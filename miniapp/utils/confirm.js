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

module.exports = { confirm };
