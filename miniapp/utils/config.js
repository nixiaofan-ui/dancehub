/**
 * DanceHub 小程序配置
 * USE_CLOUD = false  → 走 wx.request 命中 API_BASE（本地/局域网直连）
 * USE_CLOUD = true   → 走 wx.cloud.callContainer（云托管容器，无需域名无需备案）
 */
/**
 * 解析后端地址。
 *
 * 默认 localhost —— 但只在开发者工具模拟器里成立。真机预览/体验版上
 * localhost 是手机自己，必然连不上。真机调试时不想改代码，可以在开发者
 * 工具控制台执行（换成你自己电脑的局域网 IP）：
 *   wx.setStorageSync("dh_api_base", "http://192.168.x.x:3000/api")
 * 改回默认：wx.removeStorageSync("dh_api_base")
 */
function resolveApiBase() {
  const fallback = "http://localhost:3000/api";
  if (typeof wx === "undefined" || !wx.getStorageSync) return fallback;
  try {
    return wx.getStorageSync("dh_api_base") || fallback;
  } catch (e) {
    return fallback;
  }
}

const API_BASE = resolveApiBase();
// 错误提示里显示主机名：真机上看到 localhost 一眼就知道连错了地方
const API_HOST = (/^https?:\/\/([^/:]+)/.exec(API_BASE) || [, API_BASE])[1];

const config = {
  // ──── 调试开关 ────
  USE_CLOUD: false,
  // ──── 云托管相关（USE_CLOUD=true 时生效）────
  CLOUD_RUNNER_ID: "prod-d8g7j87ar768b52e7",
  CLOUD_SERVICE_NAME: "dancehub-server",
  // ──── 局域网相关（USE_CLOUD=false 时生效）────
  API_BASE,
  API_HOST,

  // ──── 备案与主体信息 ────
  // ICP 备案号：备案通过后填入，展示在「我的 → 关于」页并支持复制核验。
  // 留空时页面显示「备案审核中」——展示空号同样是违规，宁可不显示。
  ICP_NO: "",
  // 主体全称：个体工商户营业执照上的名称，须与微信认证主体一字不差（含全角括号）
  ENTITY_NAME: "",
  APP_VERSION: "1.0.0",
  // 意见反馈邮箱（「关于」页复制给用户的联系方式）
  //
  // ⚠ 微信审核会看「用户能否联系到运营者」。隐私指引里写了邮箱却留空，
  //   审核员点进来看到「反馈邮箱未配置」，基本就是驳回。
  //   改这里即可，about 页、隐私指引正文、注销/导出数据的说明都读这一个常量。
  CONTACT_EMAIL: "13260808033@163.com",
};
module.exports = config;
