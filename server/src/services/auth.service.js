import { config } from "../config.js";

/**
 * code 换 openid。
 * devId 只在「服务端没配 appid/secret」的降级模式下生效：wx.login 的 code 每次都不同，
 * 拿它当 openid 会导致每次登录都新建账号（关注列表凭空消失），
 * 改由客户端提供一个持久化的设备标识。配好 appid/secret 后本参数不参与。
 */
export async function code2session(code, devId) {
  const { appId, appSecret } = config.wechat;

  if (!appId || !appSecret) {
    const who = devId || code || "dev-user";
    return { openid: `dev:${who}`, sessionKey: "dev-session" };
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