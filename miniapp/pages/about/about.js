const { ICP_NO, ENTITY_NAME, APP_VERSION, CONTACT_EMAIL } = require("../../utils/config");
const { onNavTop } = require("../../utils/scroll-top");

/**
 * 「关于」页
 *
 * 为什么必须有这一页：
 *   1. ICP 备案号必须能在小程序内被用户看到（工信部对小程序备案的硬性要求），
 *      原来项目里没有这一页，profile 页三个 tab 也没地方放。
 *   2. 《用户隐私保护指引》需要有小程序内入口，不能只在后台配了前端找不到。
 *   3. 聚合第三方课表，需要一处集中说明数据来源，避免被误判成盗用内容。
 *
 * 备案号默认可复制：小程序不能跳外部 H5（web-view 的域名必须已备案且配成业务域名，
 * beian.miit.gov.cn 不是我们的域名，配不了），所以核验入口做成「复制备案号」，
 * 用户可自行到工信部备案系统查询。
 */
const PRIVACY_SECTIONS = [
  {
    title: "一、我们收集哪些信息",
    lines: [
      "微信登录标识：你首次打开时通过微信登录换取 openid，用于识别账号、保存你的关注与预约记录。我们不会拿到你的微信号、手机号或好友关系。",
      "你主动产生的数据：关注的舞室、预约记录、开课提醒设置。这些只属于你本人，不对其他用户公开。",
      "预约/跳转时我们会把舞室名或官网地址写入你的剪贴板，方便你粘贴到微信搜索或浏览器。我们不会读取你的剪贴板内容。",
      "我们不收集：精确位置、通讯录、相册、手机号、身份证等任何敏感个人信息。",
    ],
  },
  {
    title: "二、我们如何使用信息",
    lines: [
      "仅用于向你展示课表、保存你的关注与预约、在开课前推送提醒。",
      "开课提醒通过微信订阅消息下发，需你主动授权一次；你随时可以在「提醒设置」里关闭。",
      "我们不会将你的个人信息用于广告推荐，也不会出售给任何第三方。",
    ],
  },
  {
    title: "三、信息的存储与共享",
    lines: [
      "数据存储于中国大陆境内的服务器。",
      "我们不会向第三方共享你的个人信息。课表数据来自各舞蹈工作室公开渠道（详见「关于」页的数据来源说明）。",
    ],
  },
  {
    title: "四、你的权利",
    lines: [
      "你可以随时在「我的」里取消关注、删除预约记录、关闭提醒。",
      "如需注销账号或导出、删除你的全部数据，可通过「关于」页的邮箱联系我们，我们会在 15 个工作日内处理。",
    ],
  },
  {
    title: "五、未成年人信息",
    lines: [
      "我们不对不满 14 周岁的未成年人提供专门服务，也不会有意收集其个人信息。若你是未成年人，请在监护人陪同下使用。",
    ],
  },
  {
    title: "六、指引的更新",
    lines: [
      "本指引如有更新，会在本页更新版本日期；涉及收集范围扩大的，会重新征得你的同意。",
    ],
  },
];

Page({
  onNavTop,

  data: {
    tab: "about",
    icpNo: ICP_NO || "",
    // 没备案号时不能显示空号，显示办理中
    icpReady: Boolean(ICP_NO),
    entityName: ENTITY_NAME || "",
    version: APP_VERSION || "1.0.0",
    contactEmail: CONTACT_EMAIL || "",
    privacySections: PRIVACY_SECTIONS,
    updatedAt: "2026-09-26",
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab });
  },

  copyIcp() {
    if (!this.data.icpNo) return;
    wx.setClipboardData({
      data: this.data.icpNo,
      success: () => {
        wx.showModal({
          title: "已复制备案号",
          content: "可前往工信部备案系统（beian.miit.gov.cn）粘贴查询核验。",
          showCancel: false,
        });
      },
    });
  },

  copyEmail() {
    if (!this.data.contactEmail) return;
    wx.setClipboardData({
      data: this.data.contactEmail,
      success: () => wx.showToast({ title: "已复制邮箱", icon: "none" }),
    });
  },

  onContact() {
    if (this.data.contactEmail) return this.copyEmail();
    wx.showModal({
      title: "意见反馈",
      content: "反馈邮箱尚未配置。请在 utils/config.js 中填写 CONTACT_EMAIL。",
      showCancel: false,
    });
  },
});
