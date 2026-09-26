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

  // 以前 fetch 裸奔：容器没有公网出口时抛的是 fetch failed，微信返回的
  // errcode 又和「进程内其它异常」一起被 errorHandler 压成一句
  // 「服务器内部错误」。40029（code 无效）和「容器连不上微信」在客户端
  // 长得一模一样，只能靠猜。这里两者分开说。
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new Error(`微信接口不可达（容器可能无公网出口或超时）: ${e?.message || e}`);
  }

  const data = await resp.json();
  if (data.errcode) {
    throw new Error(`微信登录失败: ${data.errcode} ${data.errmsg}`);
  }
  return data;
}