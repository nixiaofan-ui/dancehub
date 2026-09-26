/**
 * DanceHub 小程序配置
 * USE_CLOUD = false  → 走 wx.request 命中 API_BASE（本地/局域网直连）
 * USE_CLOUD = true   → 走 wx.cloud.callContainer（云托管容器，无需域名无需备案）
 */
const config = {
  // ──── 调试开关 ────
  USE_CLOUD: false,
  // ──── 云托管相关（USE_CLOUD=true 时生效）────
  CLOUD_RUNNER_ID: "prod-d8g7j87ar768b52e7",
  CLOUD_SERVICE_NAME: "dancehub-server",
  // ──── 局域网相关（USE_CLOUD=false 时生效）────
  API_BASE: "http://localhost:3000/api",

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
