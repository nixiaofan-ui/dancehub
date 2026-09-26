import { config } from "../config.js";
import { redis } from "../lib/redis.js";

const TOKEN_KEY = "wechat:access_token";

/**
 * 云调用通道（微信云托管「开放接口服务」）。
 * 容器内直连 http://api.weixin.qq.com（注意是 http），网关自动注入鉴权 ——
 * 不用维护 access_token、不受 IP 白名单限制。
 *
 * ⚠ 为什么必须走它：云托管容器**没有公网出口**（实测 fetch api.weixin.qq.com 5ms 失败），
 * 所以「https + access_token」那条路在云上必然失败（连 token 都取不到）。
 *
 * 前置条件（控制台，缺一个都会拿到鉴权类 errcode）：
 *   云调用 → 云调用权限配置 → 加一行接口路径：/cgi-bin/message/subscribe/send
 *   云调用 → 打开「开放接口服务」开关
 */
const CLOUD_CALL_BASE = "http://api.weixin.qq.com";

// 这几个 errcode 说明「云调用通道没生效/没授权」，而不是业务失败 → 回退传统方式
const CHANNEL_ERRCODES = new Set([40001, 40013, 40164, 41002, 48001]);

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return resp.json();
}

async function fetchStableToken() {
  const data = await postJson("https://api.weixin.qq.com/cgi-bin/stable_token", {
    grant_type: "client_credential",
    appid: config.wechat.appId,
    secret: config.wechat.appSecret,
  });
  if (data.errcode) {
    throw new Error(`stable_token err ${data.errcode} ${data.errmsg}`);
  }
  return data.access_token;
}

export async function getAccessToken() {
  const cached = await redis.get(TOKEN_KEY).catch(() => null);
  if (cached) return cached;

  const token = await fetchStableToken();
  await redis.set(TOKEN_KEY, token, "EX", 7000).catch(() => {});
  return token;
}

export async function sendSubscribeMessage({ openid, templateId, page, data }) {
  const payload = {
    touser: openid,
    template_id: templateId,
    page: page || "pages/index/index",
    data,
    miniprogram_state: config.nodeEnv === "production" ? "formal" : "developer",
  };

  // ① 云调用：云上唯一走得通的路径
  let viaCloud = null;
  try {
    viaCloud = await postJson(`${CLOUD_CALL_BASE}/cgi-bin/message/subscribe/send`, payload);
  } catch (e) {
    console.warn("[dancehub] 云调用通道不可达，回退 access_token:", e?.message || e);
  }

  if (viaCloud) {
    if (viaCloud.errcode === 0) return viaCloud;
    // 业务类错误（如 43101 用户未授权）直接抛出，别拿 access_token 再试一遍
    if (!CHANNEL_ERRCODES.has(viaCloud.errcode)) {
      throw new Error(`subscribe send err ${viaCloud.errcode} ${viaCloud.errmsg}`);
    }
    console.warn(
      `[dancehub] 云调用未生效（${viaCloud.errcode} ${viaCloud.errmsg}）——` +
        "检查控制台「云调用」是否已配置 /cgi-bin/message/subscribe/send 并打开开放接口服务"
    );
  }

  // ② 传统方式：本地/局域网开发用。云上没有公网出口，这里必然失败。
  const accessToken = await getAccessToken();
  const result = await postJson(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
    payload
  );
  if (result.errcode !== 0) {
    throw new Error(`subscribe send err ${result.errcode} ${result.errmsg}`);
  }
  return result;
}
