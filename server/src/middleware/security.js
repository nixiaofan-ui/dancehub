import { config } from "../config.js";

/**
 * 安全加固中间件（不引第三方依赖，行为都是显式的）：
 *   securityHeaders —— 安全响应头
 *   makeRateLimit   —— 内存滑动窗口限流（每实例独立；云托管单副本场景够用，
 *                      将来多副本要换集中式存储再说）
 *   corsWhitelist   —— 按白名单发 CORS 头；无 Origin 的请求（小程序 / curl /
 *                      日历 App）不经过 CORS 机制，直接放行
 */

export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  // 云托管域名是 https；本地 http 调试时浏览器会忽略这条，无害
  res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
}

/**
 * 内存滑动窗口限流。
 * @param {object} opts
 * @param {number} opts.windowMs 窗口长度
 * @param {number} opts.max      窗口内每 key 允许的最大请求数
 * @param {(req) => string} [opts.key] 自定义 key（默认客户端 IP）
 */
export function makeRateLimit({ windowMs, max, key } = {}) {
  const hits = new Map(); // key -> number[]（窗口内的命中时间戳）
  const getKey = key || ((req) => req.ip || req.socket?.remoteAddress || "unknown");

  // 定期回收，防 Map 被海量一次性 IP 撑爆
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, stamps] of hits) {
      const alive = stamps.filter((t) => t > cutoff);
      if (alive.length === 0) hits.delete(k);
      else hits.set(k, alive);
    }
  }, windowMs);
  sweeper.unref?.(); // 不阻止进程退出

  return function rateLimit(req, res, next) {
    const k = getKey(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const stamps = (hits.get(k) || []).filter((t) => t > cutoff);
    if (stamps.length >= max) {
      const retryAfter = Math.ceil((stamps[0] + windowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(retryAfter, 1)));
      return res.status(429).json({ code: 429, message: "请求太频繁，请稍后再试", data: null });
    }
    stamps.push(now);
    hits.set(k, stamps);
    next();
  };
}

/** IPv4 私网段：本机 / 局域网调试用（网页开发服务器跑在局域网 IP 上） */
function isPrivateIpv4(host) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\]|localhost$)/.test(host);
}

/**
 * CORS 白名单。规则：
 *   ① 请求没有 Origin 头 → 不是浏览器跨域场景（小程序、curl、日历 App），放行；
 *   ② Origin 的 host 是 localhost / 127.0.0.1 / 私网 IP（任意端口）→ 开发环境，放行；
 *   ③ 精确命中 config.corsOrigins（env CORS_ORIGINS 逗号分隔，含协议）→ 放行；
 *   ④ 其余 → 不发 CORS 头，浏览器会拦截响应（服务器本身仍 200，防不住非浏览器）。
 * 云托管控制台把 CORS_ORIGINS 设成正式网页域名后，外部站就白嫖不了接口。
 */
export function corsWhitelist(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next(); // 非浏览器场景

  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    host = "";
  }

  const allowed =
    isPrivateIpv4(host) ||
    (config.corsOrigins || []).some((item) => item.trim().toLowerCase() === origin.toLowerCase());

  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : "false");
  if (allowed) {
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,authorization,x-admin-token");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(allowed ? 204 : 403);
  }
  next();
}
