import { config } from "../config.js";

export async function code2session(code) {
  const { appId, appSecret } = config.wechat;

  if (!appId || !appSecret) {
    return { openid: `dev:${code || "dev-user"}`, sessionKey: "dev-session" };
  }

  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${appId}&secret=${appSecret}&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;

  const resp = await fetch(url);
  const data = await resp.json();
  if (data.errcode) {
    throw new Error(`微信登录失败: ${data.errcode} ${data.errmsg}`);
  }
  return data;
}