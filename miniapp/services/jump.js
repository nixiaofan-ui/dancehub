/**
 * 预约闭环：一律「复制 + 引导去原平台」，不做小程序互跳。
 *
 * ── 为什么不再 wx.navigateToMiniProgram ──
 * 1) 平台硬限制：跳转目标必须写进 app.json 的 navigateToMiniProgramAppIdList，
 *    该名单最多 10 个且不支持动态下发。库里光 bookingMiniAppId 就有 100 个
 *    不同的（爱舞功系一个 appId 覆盖 558 家，其余 98 个各管 1–5 家），
 *    填满 10 个也救不回来，剩下的必然 fail。
 * 2) 合规风险：聚合多个第三方小程序跳转，是微信明令禁止的「小程序盒子」形态，
 *    且会把用户导给别的平台，属于高风险行为。
 * 3) 可维护性：名单写死在代码里，每接一家新平台就要发一次新版。
 *
 * 因此主路径改为：复制舞室名 → 用户在微信首页搜索 → 进官方小程序约课。
 * 代价是多两步操作，换来的是对全平台都成立、且没有合规风险。
 *
 * ── 剪贴板需要后台声明 ──
 * wx.setClipboardData 属于隐私接口，正式 appid 下若后台隐私指引未声明「剪贴板」，
 * 调用会 fail 且控制台几乎无声，表现为「点了复制毫无反应」。
 * 路径：微信公众平台 → 设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引
 *      → 更新 → 增加信息类型 → 剪贴板
 * 用途可填：「用于复制舞室名称，方便用户前往该舞室的官方小程序完成预约」
 * 本文件对这种情况做了可见提示 + 明确的控制台日志，不再让它静默失败。
 */
const { PLATFORM_LABEL } = require("../utils/constants");

function setPendingJump() {
  getApp().globalData.pendingJump = true;
}

function copy(text) {
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: text,
      success: () => resolve({ ok: true }),
      fail: (e) => resolve({ ok: false, err: (e && e.errMsg) || "setClipboardData:fail" }),
    });
  });
}

function isPrivacyBlocked(err) {
  return /privacy|not declared|scope/i.test(String(err || ""));
}

function modal(title, content) {
  wx.showModal({ title, content, showCancel: false, confirmText: "知道了" });
}

/**
 * 复制关键词并告诉用户下一步怎么走。
 * 复制失败时会把关键词直接写在弹窗里 —— 用户还能手动记下来，不至于卡死。
 */
async function copyAndGuide({ keyword, title, content }) {
  const r = await copy(keyword);
  if (r.ok) {
    setPendingJump();
    modal(title || "已复制", content);
    return;
  }
  if (isPrivacyBlocked(r.err)) {
    console.error(
      "[dancehub] 复制被微信拦截：" +
        r.err +
        "。请在小程序后台「用户隐私保护指引」里增加信息类型「剪贴板」，否则正式版复制功能不可用。",
    );
  } else {
    console.error("[dancehub] 复制失败:", r.err);
  }
  setPendingJump();
  modal("复制没成功", "请手动记下：\n「" + keyword + "」\n然后" + content.replace(/^打开/, "打开"));
}

/**
 * 店名清洗：只留品牌名，去掉分店后缀再拿去微信搜索。
 * 展示名是「品牌·分店」（如「CLAP dance studio·宝安中心店」），
 * 但微信里搜全名反而搜不到，搜品牌名才能命中它的官方小程序。
 * 顺带去掉 emoji —— 品牌自称里带的 👏🏻 之类会拖垮搜索命中率。
 */
function cleanStudioName(name) {
  let s = String(name || "").split("（")[0].split("(")[0];
  const sep = s.indexOf("·");
  if (sep > 0) s = s.slice(0, sep);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "");
  return s.trim();
}

/** 国内舞室：复制店名 → 微信首页下拉搜索 → 进官方小程序约课 */
function jumpWechat(studio) {
  const keyword = cleanStudioName(studio.name);
  return copyAndGuide({
    keyword,
    title: "已复制「" + keyword + "」",
    content:
      "打开微信 → 首页顶部搜索 → 粘贴店名 → 进入它的官方小程序选课预约。\n\nDanceHub 只做课表聚合，预约仍需在原平台完成。",
  });
}

function jumpClipboard(studio, schedule) {
  const keyword = studio.name + " " + schedule.courseName + " " + schedule.startTime;
  return copyAndGuide({
    keyword,
    title: "已复制搜索词",
    content:
      "打开" +
      (PLATFORM_LABEL[studio.platform] || "对应") +
      " App，粘贴「" +
      keyword +
      "」搜索并预约",
  });
}

/**
 * 海外场馆：复制官网/官方预约页地址，引导去浏览器打开。
 *
 * 为什么不用 web-view 直接打开：
 *   web-view 的 src 必须在后台配成「业务域名」，而业务域名要求已 ICP 备案。
 *   justjerk.co.kr / 1milliondance.com / rawgraphy.com 都是海外域名，
 *   备不了案，配不上业务域名，web-view 打不开。
 */
function jumpOfficialSite(studio, schedule) {
  const url = studio.officialUrl;
  if (!url) return jumpClipboard(studio, schedule);
  return copyAndGuide({
    keyword: url,
    title: "已复制官网地址",
    content:
      "「" +
      (studio.name || "该舞室") +
      "」是海外场馆，需在其官网预约。请粘贴到浏览器打开：\n" +
      url,
  });
}

function jumpToPlatform(studio, schedule) {
  switch (studio.platform) {
    // 国内（含 iWOD / 菲体云 / 爱舞功系）：复制店名，微信里搜索
    case "WECHAT":
      return jumpWechat(studio);
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
