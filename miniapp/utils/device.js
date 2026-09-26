/**
 * 本机调试用的设备标识。
 * 只在服务端没配 WECHAT_APPID/WECHAT_SECRET（走 dev 降级登录）时有意义。
 * 必须持久化 —— 否则每次登录都会生成一个新账号，关注列表会凭空消失。
 * 配好 appid/secret 后这个值不参与。
 */
function devDeviceId() {
  try {
    let id = wx.getStorageSync("devDeviceId");
    if (!id) {
      id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      wx.setStorageSync("devDeviceId", id);
    }
    return id;
  } catch (e) {
    return "";
  }
}

module.exports = { devDeviceId };
