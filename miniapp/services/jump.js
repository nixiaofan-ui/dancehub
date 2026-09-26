/**
 * 跳转/复制的统一出口。
 *
 * ⚠ 上线必做：本文件大量使用 wx.setClipboardData（复制舞室名、复制官网地址），
 *   而剪贴板属于微信「用户隐私保护指引」需要声明的信息类型。
 *   若不在后台声明，正式 appid 下会报
 *     setClipboardData:fail api scope is not declared in the privacy agreement
 *   表现为「点了复制毫无反应」，控制台静默失败，极难排查。
 *
 *   配置路径：微信公众平台 → 设置 → 基本设置 → 服务内容声明
 *             → 用户隐私保护指引 → 增加信息类型 → 勾选「剪贴板」
 *   用途可填：「用于复制舞室名称或官网地址，方便用户前往原平台完成预约」
 */
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

/**
 * 海外场馆：复制官网/官方预约页地址，引导去浏览器打开。
 *
 * 为什么不用 web-view 直接打开：
 *   web-view 的 src 必须在后台配成「业务域名」，而业务域名要求已 ICP 备案。
 *   justjerk.co.kr / 1milliondance.com / rawgraphy.com 都是海外域名，
 *   备不了案，配不上业务域名，web-view 打不开。
 *
 * 为什么不用 navigateToMiniProgram：
 *   日韩舞室根本没有微信小程序；而且小程序互跳正是「小程序盒子」判定里
 *   最敏感的行为，海外店本就无需跳，不碰最安全。
 */
function jumpOfficialSite(studio, schedule) {
  const url = studio.officialUrl;
  if (!url) return jumpClipboard(studio, schedule);
  wx.setClipboardData({
    data: url,
    success: () => {
      setPendingJump();
      wx.showModal({
        title: "已复制官网地址",
        content:
          "「" +
          (studio.name || "该舞室") +
          "」是海外场馆，需在其官网预约。请粘贴到浏览器打开：\n" +
          url,
        confirmText: "知道了",
        showCancel: false,
      });
    },
    fail: () => jumpClipboard(studio, schedule),
  });
}

function jumpToPlatform(studio, schedule) {
  switch (studio.platform) {
    case "WECHAT":
      return jumpWechat(studio, schedule);
    case "NAVER":
    case "INSTAGRAM":
    case "YOUTUBE":
      return jumpClipboard(studio, schedule);
    // OTHER 覆盖海外官网店（1MILLION / JustJerk / rawgraphy 系等）
    case "OTHER":
      return jumpOfficialSite(studio, schedule);
    default:
      return studio.officialUrl
        ? jumpOfficialSite(studio, schedule)
        : jumpClipboard(studio, schedule);
  }
}

module.exports = { jumpToPlatform };