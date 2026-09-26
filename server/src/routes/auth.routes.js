import { Router } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { code2session } from "../services/auth.service.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

function signToken(user) {
  return jwt.sign({ sub: user.id, openid: user.openid }, config.jwtSecret, {
    expiresIn: "30d",
  });
}

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { code, devId } = req.body || {};

    // ⚠ 云托管容器**没有公网出口**（实测 /api/diag/net 返回 unreachable: fetch failed），
    // 所以 code2session（必须访问 api.weixin.qq.com）在云上永远失败。
    // 好在微信云托管网关会在每个 callContainer 请求里注入 x-wx-openid ——
    // 走的是微信私有协议，服务未开公网访问（IsPublic=false），客户端伪造不了。
    // 云上优先用它；本地/局域网开发没有这个头，自动回退 code2session。
    const gatewayOpenid = req.headers["x-wx-openid"] || "";

    let openid = gatewayOpenid;
    let via = gatewayOpenid ? "gateway" : "";

    if (!openid) {
      if (!code) return fail(res, 400, "缺少登录 code，且网关未注入 x-wx-openid");

      // code2session 的失败原因（errcode / 网络不可达）必须原样回传：
      // 压成 500「服务器内部错误」之后，客户端只能干瞪眼。
      let session;
      try {
        session = await code2session(code, devId);
      } catch (e) {
        console.error("[dancehub] code2session failed:", e);
        return fail(res, 502, e?.message || "微信登录失败");
      }
      openid = session.openid || "";
      via = "code2session";
    }

    if (!openid) return fail(res, 401, "微信登录失败（未拿到 openid）");

    let user = await prisma.user.findUnique({ where: { openid } });
    if (!user) {
      user = await prisma.user.create({ data: { openid } });
    }

    // via 回传是给排障用的：一眼看出云上是走的网关 openid 还是 code2session
    ok(
      res,
      { token: signToken(user), via, user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl } },
      "登录成功"
    );
  }),
);

router.get(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    ok(res, { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl, homeCityId: user.homeCityId });
  }),
);

router.put(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { nickname, avatarUrl, homeCityId } = req.body || {};
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        ...(nickname !== undefined ? { nickname } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        ...(homeCityId !== undefined ? { homeCityId: Number(homeCityId) || null } : {}),
      },
    });
    ok(res, { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl, homeCityId: user.homeCityId });
  }),
);

export default router;