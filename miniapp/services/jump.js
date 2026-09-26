const { PLATFORM_LABEL } = require("../utils/constants");

const WECHAT_APP_ID_MAP = {
  // 兜底：服务端 bookingMiniAppId 缺失时的补充配置（studioId → appId）
};

function setPendingJump() {
  getApp().globalData.pendingJump = true;
}

function jumpWechat(studio, schedule) {
  // 优先用服务端返回的官方约课小程序 appId（iWOD 系店铺已配置）
  const appId = studio.bookingMiniAppId || WECHAT_APP_ID_MAP[studio.id];
  if (appId) {
    wx.navigateToMiniProgram({
      appId,
      fail: () => {
        wx.showToast({ title: "跳转失败，请重试", icon: "none" });
      },
    });
    setPendingJump();
    return;
  }
  // 无 appId（菲体云系）：复制店名引导用户在微信里搜索官方小程序
  const keyword = (studio.name || "").split("（")[0];
  wx.setClipboardData({
    data: keyword,
    success: () => {
      setPendingJump();
      wx.showModal({
        title: "已复制舞室名",
        content:
          "该舞室暂无法直接跳转。请打开微信首页下拉搜索「" +
          keyword +
          "」，进入它的官方小程序完成预约。",
        showCancel: false,
      });
    },
  });
}

function jumpClipboard(studio, schedule) {
  const keyword = studio.name + " " + schedule.courseName + " " + schedule.startTime;
  wx.setClipboardData({
    data: keyword,
    success: () => {
      setPendingJump();
      wx.showModal({
        title: "已复制搜索词",
        content:
          "请打开" +
          (PLATFORM_LABEL[studio.platform] || "对应") +
          " App，粘贴「" +
          keyword +
          "」搜索并预约",
        showCancel: false,
      });
    },
  });
}

function jumpToPlatform(studio, schedule) {
  switch (studio.platform) {
    case "WECHAT":
      return jumpWechat(studio, schedule);
    case "NAVER":
    case "INSTAGRAM":
    default:
      return jumpClipboard(studio, schedule);
  }
}

module.exports = { jumpToPlatform };