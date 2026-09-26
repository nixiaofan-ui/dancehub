// 请求一次性订阅消息授权，返回是否同意
function requestSubscribe(tmplId) {
  return new Promise((resolve) => {
    // 模板 ID 为空时不能静默跳过 —— 否则用户点了「提醒」却永远收不到推送，
    // 而页面还提示「已开启提醒」，是最难排查的一类假成功。
    if (!tmplId) {
      console.warn("[dancehub] 订阅模板 ID 为空，跳过授权。检查 /config/subscribe 是否返回 classReminderTplId");
      resolve(false);
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success(res) {
        // 结果形如 { Gpl6bGd...: "accept" | "reject" | "ban" | "filter" }
        console.log("[dancehub] 订阅授权返回:", JSON.stringify(res));
        resolve(res[tmplId] === "accept");
      },
      fail(e) {
        // 常见：can only be invoked by user TAP gesture（不在点击回调的同步链里）
        console.warn("[dancehub] 订阅授权失败:", (e && e.errMsg) || e);
        resolve(false);
      },
    });
  });
}

module.exports = { requestSubscribe };
