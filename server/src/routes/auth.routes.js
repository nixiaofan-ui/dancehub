import { Router } from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { code2session, WxAuthError } from "../services/auth.service.js";
import { requireAuth } from "../middleware/auth.js";
import { ENTRY_GATEWAY, ENTRY_PUBLIC } from "../middleware/entry.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

function signToken(user, expiresIn = "30d") {
  return jwt.sign({ sub: user.id, openid: user.openid }, config.jwtSecret, {
    expiresIn,
  });
}

const maskOpenid = (v) =>
  v && v.length > 10 ? `${v.slice(0, 6)}***${v.slice(-4)}` : v || "";

/** 只回传展示用的字段：openid 属于凭据，一律不出服务端 */
const publicUser = (user) => ({
  id: user.id,
  nickname: user.nickname,
  avatarUrl: user.avatarUrl,
  homeCityId: user.homeCityId,
});

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
}/**
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

/* ────────────────────────────────────────────────────────────────
 * 网页版登录：配对码（pair code）
 *
 * 为什么不是微信登录 / 手机号验证码，见 schema.prisma 的 model PairCode 注释：
 * 网页扫码要开放平台网站应用（企业主体 + 300 元/年），微信内网页授权要认证服务号，
 * 手机号要备案 + 短信签名审核 —— 个人主体当下一条都走不通。
 * 配对码的体验接近「电视投屏码」：小程序里生成 6 位码，网页输一次，之后免登录。
 * ──────────────────────────────────────────────────────────────── */

const PAIR_TTL_MS = 5 * 60 * 1000; // 码 5 分钟有效
const PAIR_TOKEN_TTL = "180d"; // 换到的登录凭证有效期：半年内不用再输码
const REDEEM_WINDOW_MS = 10 * 60 * 1000;
const REDEEM_MAX_PER_IP = 10;

// 兑换接口的限流放在内存里：单容器部署够用，重启即清零（清零方向是安全的）。
// ⚠ 若将来扩到多实例，这里必须换成 Redis —— 否则限流变成「每个实例各 10 次」。
const redeemHits = new Map();

function redeemLimited(ip) {
  const now = Date.now();
  const rec = redeemHits.get(ip);
  if (!rec || rec.resetAt <= now) {
    if (redeemHits.size > 5000) {
      for (const [key, value] of redeemHits) if (value.resetAt <= now) redeemHits.delete(key);
    }
    redeemHits.set(ip, { count: 1, resetAt: now + REDEEM_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > REDEEM_MAX_PER_IP;
}

/** 6 位数字码；撞码时重试（列上有唯一索引兜底，不能只靠随机数） */
async function issuePairCode(userId) {
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS);
  // 一人一码：把该用户此前没用掉的码作废，避免同时有多条有效码可被撞
  await prisma.pairCode.deleteMany({ where: { userId, usedAt: null } });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      return await prisma.pairCode.create({ data: { code, userId, expiresAt } });
    } catch (err) {
      if (err?.code !== "P2002") throw err; // P2002 = 唯一键冲突，换一个码重试
    }
  }
  throw new Error("生成登录码失败，请重试");
}

router.post(
  "/pair-code",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await issuePairCode(req.userId);
    console.log(
      `[dancehub] pair-code issued user=${req.userId} code=${row.code.slice(0, 2)}**** expires=${row.expiresAt.toISOString()}`
    );
    ok(
      res,
      { code: row.code, expiresAt: row.expiresAt, ttlSeconds: Math.round(PAIR_TTL_MS / 1000) },
      "登录码已生成"
    );
  })
);

router.post(
  "/pair-code/redeem",
  asyncHandler(async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (redeemLimited(ip)) {
      console.warn(`[dancehub] pair-code redeem 限流 ip=${ip}`);
      return fail(res, 429, "尝试次数太多，请 10 分钟后再试");
    }

    const code = String((req.body || {}).code || "").replace(/\D/g, "");
    if (code.length !== 6) return fail(res, 400, "请输入 6 位数字登录码");

    const row = await prisma.pairCode.findUnique({
      where: { code },
      include: { user: true },
    });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
      console.warn(`[dancehub] pair-code redeem 失败 ip=${ip} 原因=无效或过期`);
      return fail(res, 404, "登录码无效或已过期，请在 App 里重新生成");
    }

    // 条件更新 = 原子作废：两个请求同时拿同一个码，只有一个能把 usedAt 写进去
    const burned = await prisma.pairCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!burned.count) return fail(res, 409, "登录码已被使用，请重新生成");

    console.log(
      `[dancehub] pair-code redeemed user=${row.userId} ip=${ip} openid=${maskOpenid(row.user.openid)}`
    );
    ok(
      res,
      {
        token: signToken(row.user, PAIR_TOKEN_TTL),
        expiresInDays: Math.round(180),
        user: publicUser(row.user),
      },
      "已关联账号"
    );
  })
);

/**
 * 续期：网页每次打开时，只要本地 token 还有效就换一张新的 180 天。
 * 于是「每半年至少来一次」的用户永远不会掉登录，掉登录只发生在真的半年没来过。
 */
router.post(
  "/refresh",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return fail(res, 401, "账号不存在，请重新关联");
    ok(res, { token: signToken(user, PAIR_TOKEN_TTL), expiresInDays: 180, user: publicUser(user) });
  })
);

/**
 * 手机日历同步：网页端把本机提醒（课程提醒 + 每周放课提醒）镜像上来，
 * 换一个 calToken，日历 App 用它匿名拉 ICS（日历 App 不会带请求头）。
 * 只存白名单字段，别把浏览器里的任意 JSON 整包吞进库。
 */
router.post(
  "/calendar-sync",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const pickReminder = (r) => ({
      scheduleDate: String(r.scheduleDate || "").slice(0, 10),
      startTime: String(r.startTime || "").slice(0, 5),
      endTime: String(r.endTime || r.startTime || "").slice(0, 5),
      courseName: String(r.courseName || "课程").slice(0, 80),
      coachName: String(r.coachName || "").slice(0, 40),
      studioName: String(r.studioName || "").slice(0, 80),
    });
    const reminders = (Array.isArray(body.reminders) ? body.reminders : [])
      .slice(0, 60)
      .filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.scheduleDate || "")))
      .map(pickReminder);
    const rawWatches =
      body.watches && typeof body.watches === "object" && !Array.isArray(body.watches)
        ? Object.entries(body.watches).slice(0, 20)
        : [];
    const watches = {};
    rawWatches.forEach(([id, w]) => {
      const weekdays = Array.isArray(w?.weekdays)
        ? [...new Set(w.weekdays.map(Number).filter((n) => n >= 0 && n <= 6))].slice(0, 7)
        : [];
      if (!weekdays.length || !/^\d{2}:\d{2}$/.test(String(w?.time || ""))) return;
      watches[String(id).slice(0, 24)] = {
        studioName: String(w.studioName || "").slice(0, 80),
        weekdays,
        time: String(w.time),
      };
    });

    let calToken = (await prisma.user.findUnique({ where: { id: req.userId }, select: { calToken: true } }))?.calToken;
    if (!calToken) {
      calToken = crypto.randomBytes(24).toString("hex");
    }
    await prisma.user.update({
      where: { id: req.userId },
      data: { calToken, calReminders: { reminders, watches } },
    });
    ok(res, { calToken, reminders: reminders.length, watches: Object.keys(watches).length }, "已同步");
  })
);

export default router;
