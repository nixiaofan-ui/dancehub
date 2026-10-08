/**
 * 请求入口判定：**微信网关** 还是 **公网**。
 *
 * ⛔ 先读这一段，否则很容易把它误当鉴权用。
 *
 * 背景（2026-10-08 实测的漏洞）：本服务的公网访问是**开着**的，而
 * `x-wx-openid` 只是网关转发时注入的一个**普通请求头**。公网请求带一个
 * 同名头进来，网关不会拦、也不会剥掉 —— 实测：
 *
 *     curl -X POST https://<服务域名>/api/auth/login \
 *          -H 'x-wx-openid: 任意值' -d '{}'
 *     → 登录成功，并据此新建了一个账号
 *
 * 所以 `req.entry === "gateway"` **不能**当作「这个用户已通过微信验证」的证据：
 * 任何人都能在公网入口把这一组头伪装出来。
 *
 * 那它有什么用？
 *   1. 身份层：登录身份一律由 `code` 证明（code 由 wx.login() 签发、一次性、
 *      绑定 appid，伪造不出来）——见 services/auth.service.js 与 auth.routes.js。
 *      本标签只用来决定「要不要为了容灾而允许网关头兜底」，那是显式策略，不是默认。
 *   2. 观测：出问题时一眼看出请求是从哪条路进来的（/api/diag/net 会回传）。
 *   3. 将来若要「某接口只允许小程序调用」，落点在这里。
 *
 * 真正的边界只有一条：**在控制台关掉「公网访问」**（openAccessTypes 去掉 PUBLIC）。
 * 关掉之后外部连不进来，网关头才重新变得可信。本文件不替代那一步。
 */

import { config } from "../config.js";

export const ENTRY_GATEWAY = "gateway";
export const ENTRY_PUBLIC = "public";

const HEADER_OPENID = "x-wx-openid";
const HEADER_APPID = "x-wx-appid";

/**
 * 判定单个请求来自哪条入口。
 *
 * 判据（够用即可，别指望它扛攻击）：
 *   - 没有 `x-wx-openid`            → 公网（网关一定会注入）
 *   - 有，但 `x-wx-appid` 与自己的小程序 appId 对不上 → 公网（挡掉「别的 app 的头被误转发」这类脏数据）
 *   - 有，且 appid 一致或上游没给 appid → 网关
 *
 * @param {Record<string, unknown>} headers
 * @returns {{ entry: "gateway"|"public", why: string }}
 */
export function classifyEntry(headers = {}) {
  const openid = String(headers[HEADER_OPENID] || "").trim();
  const appid = String(headers[HEADER_APPID] || "").trim();

  if (!openid) return { entry: ENTRY_PUBLIC, why: "no-gateway-openid" };
  if (appid && config.wechat.appId && appid !== config.wechat.appId) {
    return { entry: ENTRY_PUBLIC, why: "appid-mismatch" };
  }
  return { entry: ENTRY_GATEWAY, why: appid ? "gateway-openid-appid" : "gateway-openid-no-appid" };
}

export function tagEntry(req, _res, next) {
  const r = classifyEntry(req.headers || {});
  req.entry = r.entry;
  req.entryWhy = r.why;
  next();
}

/**
 * 「只允许小程序网关调用」的守卫。目前没有接口挂它，先留着：
 * 一旦发现某个写接口被公网滥用，直接 `router.post(path, requireGatewayEntry, handler)`。
 * ⚠ 前提同上 —— 公网能伪造这些头，所以它只在「公网访问已关闭」时才是真边界。
 */
export function requireGatewayEntry(req, res, next) {
  if (req.entry === ENTRY_GATEWAY) return next();
  // 这里刻意不回 401：401 会让小程序的请求层触发「自动重登」，
  // 而重登也过不去，只会把一次失败放大成三次。
  return res.status(403).json({
    code: 403,
    message: "该接口仅支持小程序网关调用",
    data: { entry: req.entry, why: req.entryWhy },
  });
}
