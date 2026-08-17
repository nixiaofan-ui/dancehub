import { config } from "../config.js";
import { redis } from "../lib/redis.js";

const TOKEN_KEY = "wechat:access_token";

async function fetchStableToken() {
  const resp = await fetch("https://api.weixin.qq.com/cgi-bin/stable_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credential",
      appid: config.wechat.appId,
      secret: config.wechat.appSecret,
    }),
  });
  const data = await resp.json();
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
  const accessToken = await getAccessToken();
  const resp = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openid,
        template_id: templateId,
        page: page || "pages/index/index",
        data,
        miniprogram_state: config.nodeEnv === "production" ? "formal" : "developer",
      }),
    },
  );
  const result = await resp.json();
  if (result.errcode !== 0) {
    throw new Error(`subscribe send err ${result.errcode} ${result.errmsg}`);
  }
  return result;
}