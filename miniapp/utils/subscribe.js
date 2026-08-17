// 请求一次性订阅消息授权，返回是否同意
function requestSubscribe(tmplId) {
  return new Promise((resolve) => {
    if (!tmplId) return resolve(false);
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success(res) {
        resolve(res[tmplId] === "accept");
      },
      fail() {
        resolve(false);
      },
    });
  });
}

module.exports = { requestSubscribe };