import { Router } from "express";
import dns from "node:dns/promises";
import { prisma } from "../lib/prisma.js";
import { pingRedis } from "../lib/redis.js";

const router = Router();

router.get("/health", async (_req, res) => {
  const result = { status: "ok", db: "unknown", redis: "unknown" };

  try {
    await prisma.$queryRaw`SELECT 1`;
    result.db = "ok";
  } catch {
    result.db = "error";
    result.status = "degraded";
  }

  try {
    await pingRedis();
    result.redis = "ok";
  } catch {
    result.redis = "error";
    result.status = result.status === "ok" ? "degraded" : result.status;
  }

  res.json(result);
});

/**
 * 网络自检：容器到底能不能连到微信服务器。
 * 「登录一直 500」时最需要区分的两件事：微信说我们的 code 无效（40029），
 * 还是容器压根连不出去（云托管未开公网出口）。用假凭据探测，
 * 只要能拿到微信的 JSON 回包（哪怕是报错）就说明出口是通的。
 */
const mask = (v) => (v && v.length > 8 ? `${v.slice(0, 4)}***${v.slice(-4)}(${v.length})` : v || "");

router.get("/diag/net", async (req, res) => {
  const out = { wechatApi: "unknown", dns: "unknown", baidu: "unknown", wxHeaders: {} };

  // 网关到底注没注入 x-wx-openid，决定了登录能不能绕开 code2session
  for (const k of Object.keys(req.headers)) {
    if (k.startsWith("x-wx-")) out.wxHeaders[k] = k === "x-wx-openid" ? mask(req.headers[k]) : req.headers[k];
  }

  // 区分「DNS 解析不了」和「有 IP 但连不出去」——两者的修法不同
  try {
    const a = await dns.lookup("api.weixin.qq.com");
    out.dns = "ok " + a.address;
  } catch (e) {
    out.dns = "fail:" + (e?.code || e?.message || e);
  }

  const t0 = Date.now();
  try {
    const r = await fetch(
      "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=probe&secret=probe",
      { signal: AbortSignal.timeout(8000) }
    );
    const j = await r.json();
    out.wechatApi = j.errcode ? `reachable(errcode=${j.errcode})` : "reachable";
  } catch (e) {
    out.wechatApi = "unreachable: " + (e?.message || e);
  }
  out.wechatMs = Date.now() - t0;

  try {
    const r = await fetch("https://www.baidu.com", { signal: AbortSignal.timeout(8000) });
    out.baidu = "reachable " + r.status;
  } catch (e) {
    out.baidu = "unreachable: " + (e?.message || e);
  }

  res.json(out);
});

export default router;