import { config } from "../config.js";

/**
 * 微信登录凭据被微信**明确拒绝**（回了 errcode）。
 * 说明通道是好的 —— 是这个 code / 密钥本身不合法。这类错误不能降级、不能重试。
 */
export class WxAuthError extends Error {
  constructor(message, errcode) {
    super(message);
    this.name = "WxAuthError";
    this.errcode = errcode ?? null;
  }
}

/**
 * 通道不可用（连不上 / 超时 / 回来的不是 JSON）。
 * 与「凭据不合法」是两件完全不同的事：只有这一类才允许上层降级到别的通道或别的凭据来源。
 * 混在一起的代价很实在 —— 40029（code 无效）和「容器连不上微信」在客户端长得一模一样，
 * 只能靠猜（见 2026-09-30 那次登录 500 的排查）。
 */
export class WxChannelError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "WxChannelError";
    this.cause = cause;
  }
}

const JSCODE_PATH = "/sns/jscode2session";

/**
 * 云调用通道：容器内 **http**（不是 https）打 api.weixin.qq.com。
 *
 * 为什么是 http：云托管把 `api.weixin.qq.com` 解析到 169.254.10.1（链路本地地址，
 * 实测 /api/diag/net 的 dns 字段），由平台在自己那侧拦截转发。
 * 好处是**不需要容器有公网出口** —— 而本容器的公网出口是没有的
 * （https://api.weixin.qq.com 报 `unreachable: fetch failed`）。
 * 同一条通道已经在 /api/diag/cloudcall 上验证可用（subscribe/send 返回 40003）。
 */
const CLOUD_BASE = "http://api.weixin.qq.com";
/** 公网通道：本地开发、或有公网出口的环境走这条 */
const PUBLIC_BASE = "https://api.weixin.qq.com";

/** 云调用通道挂掉后，这段时间内不再每单都白等一次超时 */
const CLOUD_DOWN_TTL_MS = 10 * 60 * 1000;
let cloudDownUntil = 0;

export function channelState() {
  return { cloudDownUntil, cloudDown: Date.now() < cloudDownUntil };
}

/** 仅供烟测 */
export function __resetChannelState() {
  cloudDownUntil = 0;
}

async function callJscode2Session(base, { appId, appSecret, code, timeoutMs }) {
  const url =
    `${base}${JSCODE_PATH}` +
    `?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;

  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new WxChannelError(`微信接口不可达（${base}）：${e?.message || e}`, e);
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    // 返回体不是 JSON（代理返回了 HTML 错误页 / 空的 4xx）→ 属于通道问题，不是凭据问题
    throw new WxChannelError(`微信接口返回的不是 JSON（${base}，HTTP ${resp.status}）`, e);
  }

  if (data.errcode) {
    throw new WxAuthError(`微信登录失败：${data.errcode} ${data.errmsg || ""}`.trim(), data.errcode);
  }
  if (!data.openid) {
    throw new WxAuthError("微信登录失败：响应里没有 openid", null);
  }
  return { openid: data.openid, sessionKey: data.session_key || "", channel: base };
}

/**
 * code 换 openid。
 *
 * 优先云调用通道（容器无公网出口时唯一能通的路），失败回落公网 https。
 * 两个通道都不可用才抛 WxChannelError —— 上层据此决定要不要降级到别的凭据来源。
 *
 * devId 只在「服务端没配 appid/secret」的降级模式下生效：wx.login 的 code 每次都不同，
 * 拿它当 openid 会导致每次登录都新建账号（关注列表凭空消失），
 * 改由客户端提供一个持久化的设备标识。配好 appid/secret 后本参数不参与。
 */
export async function code2session(code, devId) {
  const { appId, appSecret } = config.wechat;

  if (!appId || !appSecret) {
    const who = devId || code || "dev-user";
    return { openid: `dev:${who}`, sessionKey: "dev-session", channel: "dev-fallback" };
  }

  const errors = [];

  if (Date.now() >= cloudDownUntil) {
    try {
      const r = await callJscode2Session(CLOUD_BASE, { appId, appSecret, code, timeoutMs: 5000 });
      return { ...r, channel: "cloud-call" };
    } catch (e) {
      // 微信明确拒绝 → 是 code 的问题，换通道也一样，直接上抛（别浪费一次请求）
      if (e instanceof WxAuthError) throw e;
      cloudDownUntil = Date.now() + CLOUD_DOWN_TTL_MS;
      errors.push(`云调用：${e.message}`);
    }
  } else {
    errors.push("云调用：上次失败，冷却中");
  }

  try {
    const r = await callJscode2Session(PUBLIC_BASE, { appId, appSecret, code, timeoutMs: 8000 });
    return { ...r, channel: "https-public" };
  } catch (e) {
    if (e instanceof WxAuthError) throw e;
    errors.push(`公网：${e.message}`);
  }

  throw new WxChannelError(`code2session 两个通道都不可用 —— ${errors.join(" / ")}`);
}

const maskTail = (v) =>
  v && v.length > 8 ? `${v.slice(0, 4)}***${v.slice(-4)}(${v.length})` : v || "";

/**
 * 通道自检：用一个**故意无效的 code** 去打两个通道，只看回的是哪一类结果。
 *
 * 关心的不是业务结果，而是「通道通不通 + 凭据注入对不对」：
 *   40029 / 40163（code 无效/已使用） → ✅ 通道可用、appid/secret 有效
 *   40013 / 41002（appid 不合法/缺失） → 通道通，但 appid 不对
 *   40125（secret 不合法）             → 通道通，但 secret 不对
 *   连不上 / 非 JSON                    → ✖ 该通道不可用
 *
 * ⛔ 刻意用底层函数而不是 code2session：自检不该污染 cloudDownUntil 那个冷却状态。
 */
export async function probeCode2session() {
  const { appId, appSecret } = config.wechat;
  const out = {
    configured: Boolean(appId && appSecret),
    appId: maskTail(appId),
    secret: maskTail(appSecret),
    cloudCall: null,
    httpsPublic: null,
    verdict: "",
  };

  if (!out.configured) {
    out.verdict =
      "未配置 WECHAT_APPID / WECHAT_SECRET：code2session 会走 dev 兜底（openid 形如 dev:xxx），线上绝不该出现";
    return out;
  }

  const targets = [
    ["cloudCall", CLOUD_BASE, 5000],
    ["httpsPublic", PUBLIC_BASE, 8000],
  ];

  const judge = (e) => {
    if (e instanceof WxAuthError) {
      const appIdBad = [40013, 41002].includes(e.errcode);
      const secretBad = e.errcode === 40125;
      return {
        ok: true,
        errcode: e.errcode,
        message: e.message,
        verdict: appIdBad
          ? "⚠ 通道可用，但 appid 被拒：检查 WECHAT_APPID"
          : secretBad
            ? "⚠ 通道可用，但 secret 被拒：检查 WECHAT_SECRET"
            : "✅ 通道可用（微信已应答；invalid code 是自检故意传的）",
      };
    }
    return { ok: false, errcode: null, message: e.message, verdict: "✖ 通道不可用" };
  };

  for (const [key, base, timeoutMs] of targets) {
    try {
      await callJscode2Session(base, { appId, appSecret, code: "diag-invalid-code", timeoutMs });
      // 假 code 竟然换到了 openid —— 不可能，除非上游被换掉了
      out[key] = { ok: false, errcode: null, message: "假 code 换到了 openid", verdict: "✖ 结果异常" };
    } catch (e) {
      out[key] = judge(e);
    }
  }

  out.verdict =
    out.cloudCall && out.cloudCall.ok
      ? "✅ 云调用通道可用 —— 登录可完全由 code 证明，网关头不再是身份来源"
      : out.httpsPublic && out.httpsPublic.ok
        ? "⚠ 只有公网通道可用（容器有公网出口）—— 云上通常不是这个形态，注意确认"
        : "✖ 两个通道都不可用：线上登录只可能靠网关头兜底，应尽快关闭公网访问";

  return out;
}
