import { Router } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { code2session, WxAuthError } from "../services/auth.service.js";
import { requireAuth } from "../middleware/auth.js";
import { ENTRY_GATEWAY, ENTRY_PUBLIC } from "../middleware/entry.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

function signToken(user) {
  return jwt.sign({ sub: user.id, openid: user.openid }, config.jwtSecret, {
    expiresIn: "30d",
  });
}

const maskOpenid = (v) =>
  v && v.length > 10 ? `${v.slice(0, 6)}***${v.slice(-4)}` : v || "";

async function finishLogin(res, { openid, via, entry, policy }) {
  let user = await prisma.user.findUnique({ where: { openid } });
  const isNew = !user;
  if (!user) user = await prisma.user.create({ data: { openid } });

  // 每次登录都留一行：via / entry / policy 三者合起来能一眼看出身份是哪来的。
  // 「账号莫名变多」时要的就是这行 —— 旧实现什么都看不到。
  console.log(
    `[dancehub] login ok via=${via} entry=${entry} policy=${policy} openid=${maskOpenid(openid)}${isNew ? " (新建账号)" : ""}`
  );

  ok(
    res,
    {
      token: signToken(user),
      via,
      // 回传给客户端只为排障/观测，不参与任何判断
      entry,
      policy,
      user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl },
    },
    "登录成功"
  );
}

/**
 * 登录 —— 身份的唯一入口。
 *
 * ── 为什么这么写（2026-10-08 修的真实漏洞）────────────────────────────
 * 旧实现无条件信任网关注入的 `x-wx-openid`，而本服务的公网访问是开着的，
 * 于是任何人 curl 带一个 `x-wx-openid: 任意值` 就能登录、每换一个值就新建一个账号：
 *
 *     curl -X POST https://<服务域名>/api/auth/login -H 'x-wx-openid: whatever' -d '{}'
 *     → 200，user 表 +1
 *
 * 关键在于：`x-wx-openid` 只是**一个请求头**，公网请求能完整伪造（实测网关不会剥掉它）。
 * 所以它天然不能当凭据。
 *
 * 真正不可伪造的是 `code`（wx.login() 签发、一次性、绑定 appid）。小程序本来就每次都带
 * code（services/api.js 的 apiLogin / request.js 的 relogin），只是旧实现把它当备胎。
 * 现在反过来：**code 是首选，网关头是受控兜底**。
 * ────────────────────────────────────────────────────────────────
 */
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { code, devId } = req.body || {};
    const entry = req.entry || ENTRY_PUBLIC;
    const policy = config.gatewayIdentity;
    const gatewayOpenid = String(req.headers["x-wx-openid"] || "").trim();

    // ① 首选：让 code 说话。走通时「请求从哪条入口进来」完全不重要。
    let channelError = "";
    if (code) {
      try {
        const session = await code2session(code, devId);
        return await finishLogin(res, {
          openid: session.openid,
          via: `code2session:${session.channel}`,
          entry,
          policy,
        });
      } catch (e) {
        // 微信明确拒绝这个 code —— 换通道/换凭据来源都没意义，直接说清楚。
        if (e instanceof WxAuthError) return fail(res, 401, e.message);
        channelError = e.message;
        console.error("[dancehub] code2session 通道不可用：", e.message);
      }
    }

    // ② 网关头：只有显式允许时才算身份。默认（auto）只在「通道真的挂了」时才兜底。
    if (!gatewayOpenid) {
      return code
        ? fail(res, 502, `微信登录通道不可用：${channelError}`)
        : fail(res, 400, "缺少登录 code，且网关未注入 x-wx-openid");
    }

    if (policy === "off") {
      return fail(
        res,
        401,
        `登录通道不可用，且策略 GATEWAY_IDENTITY=off 禁止使用网关头：${channelError || "未提供 code"}`
      );
    }

    const autoFallbackOk = entry === ENTRY_GATEWAY && Boolean(channelError);
    if (policy !== "always" && !autoFallbackOk) {
      // ⛔ 这段就是本次漏洞的回归钉：公网入口伪造 x-wx-openid（且拿不出有效 code）
      //    必须在这里被挡住，绝不能建号。
      console.warn(
        `[dancehub] 拒绝网关头登录：entry=${entry}(${req.entryWhy}) policy=${policy} ` +
          `channelError=${channelError || "无 code"}`
      );
      return fail(res, 401, "登录凭据无法验证：请提供微信登录 code");
    }

    console.warn(
      `[dancehub] 降级用网关头登录：entry=${entry} policy=${policy} 原因=${channelError || "policy=always"}`
    );
    await finishLogin(res, {
      openid: gatewayOpenid,
      via: policy === "always" ? "gateway:always" : "gateway:channel-down",
      entry,
      policy,
    });
  })
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
