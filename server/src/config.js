import "dotenv/config";

/**
 * 登录身份策略：`x-wx-openid` 这个网关注入的头，能不能直接当身份用。
 *
 * 三档（env `GATEWAY_IDENTITY`，非法值一律 fail-closed 到 `auto`）：
 *
 *   auto（默认）—— 身份**先由 `code` 证明**（code 由 wx.login() 签发、一次性、
 *                  绑定 appid，伪造不出来）。只有当 code2session **通道**本身
 *                  不可用（网络/DNS/代理故障，而不是「code 无效」这类业务错误）
 *                  时，才允许**网关入口**用 `x-wx-openid` 兜底。
 *                  ⚠ 攻击者制造不出「通道不可用」，所以这条路不构成可利用面。
 *
 *   off        —— 永不用网关头当身份。通道挂了就是挂了，宁可登录不上。
 *                  确认云调用通道稳定后，建议收敛到这一档。
 *
 *   always     —— 完全信任网关头（= 2026-10-08 修复前的历史行为）。
 *                  ⛔ 只有确认控制台已**关闭公网访问**时才可以用：公网可达时，
 *                     任何人 curl 带一个 x-wx-openid 就能登录并无限建号。
 */
function readGatewayIdentity() {
  const raw = String(process.env.GATEWAY_IDENTITY || "auto").trim().toLowerCase();
  if (raw === "auto" || raw === "off" || raw === "always") return raw;
  console.warn(
    `[dancehub] GATEWAY_IDENTITY="${raw}" 不是合法取值（auto|off|always），已按最安全的 auto 处理`
  );
  return "auto";
}

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  jwtSecret: process.env.JWT_SECRET || "dev-secret-do-not-use-in-prod",
  adminToken: process.env.ADMIN_TOKEN || "admin123",
  gatewayIdentity: readGatewayIdentity(),
  wechat: {
    appId: process.env.WECHAT_APPID || "",
    appSecret: process.env.WECHAT_SECRET || "",
    classReminderTplId: process.env.WX_CLASS_REMINDER_TMPL || "",
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || "",
  },
};

export const isDev = () => config.nodeEnv === "development";