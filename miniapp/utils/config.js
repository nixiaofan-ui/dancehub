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
};
module.exports = config;
