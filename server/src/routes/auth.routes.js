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
    const { code } = req.body || {};
    if (!code) return fail(res, 400, "缺少登录 code");

    const session = await code2session(code);
    if (!session.openid) return fail(res, 401, "微信登录失败");

    let user = await prisma.user.findUnique({ where: { openid: session.openid } });
    if (!user) {
      user = await prisma.user.create({ data: { openid: session.openid } });
    }

    ok(res, { token: signToken(user), user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl } }, "登录成功");
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