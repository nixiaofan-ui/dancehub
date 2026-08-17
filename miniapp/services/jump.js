const { PLATFORM_LABEL } = require("../utils/constants");

const WECHAT_APP_ID_MAP = {
  // TODO: 配置目标门店小程序的 appId，例如 123456: "wx1234567890abcdef"
};

function setPendingJump() {
  getApp().globalData.pendingJump = true;
}

function jumpWechat(studio, schedule) {
  const appId = WECHAT_APP_ID_MAP[studio.id];
  if (appId) {
    wx.navigateToMiniProgram({ appId });
    setPendingJump();
    return;
  }
  // 未配置 appId：降级为 WebView 打开 H5 或复制链接
  if (schedule.bookingUrl) {
    wx.navigateTo({
      url: "/pages/webview/webview?url=" + encodeURIComponent(schedule.bookingUrl),
    });
  } else {
    wx.showToast({ title: "暂无可用的预约链接", icon: "none" });
  }
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