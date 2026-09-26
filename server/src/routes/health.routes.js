import { Router } from "express";
import dns from "node:dns/promises";
import { prisma } from "../lib/prisma.js";
import { pingRedis } from "../lib/redis.js";
import { config } from "../config.js";
import { buildClassReminderData } from "../services/reminder.service.js";

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

// 这几个 errcode 表示「云调用通道没生效」，而不是业务参数错
const CHANNEL_ERRCODES = new Set([40001, 40013, 40125, 40164, 41002, 48001, 48002]);

/**
 * 云调用自检：验证控制台「开放接口服务 + 配置接口」是否真的生效。
 *
 * 用**故意写错的参数**去打 subscribe/send —— 这里关心的不是业务结果，
 * 而是返回的是哪一类 errcode：
 *   40001/48001/40164…（鉴权类） → 通道没生效：接口路径没配，或配完没重建版本
 *   40003/40037/47003（参数类）  → ✅ 鉴权已通过，云调用通了
 * 这样不用等到真的有人开课提醒就能判断配置对不对。
 */
router.get("/diag/cloudcall", async (req, res) => {
  // ?real=1 → 用库里最后一个真实 openid 发，验证「参数已被微信接受，只差用户授权」。
  // 一次性订阅每授权只能发一条，所以在让用户点授权前先用这个确认字段没问题。
  const useReal = String(req.query?.real || "") === "1";
  let touser = "diag-invalid-openid";
  if (useReal) {
    const u = await prisma.user.findFirst({
      where: { openid: { not: { startsWith: "dev:" } } },
      orderBy: { id: "desc" },
      select: { openid: true },
    });
    touser = u?.openid || "diag-invalid-openid";
  }

  const out = {
    target: "http://api.weixin.qq.com/cgi-bin/message/subscribe/send",
    mode: useReal ? "real-openid" : "fake-openid",
    // 真实 openid 只在末 4 位，避免整个响应体泄露用户标识
    touser: touser === "diag-invalid-openid" ? touser : touser.slice(0, 6) + "***" + touser.slice(-4),
    errcode: null,
    errmsg: "",
    ms: 0,
    templateConfigured: Boolean(config.wechat.classReminderTplId),
    verdict: "unknown",
  };

  const t0 = Date.now();
  try {
    const r = await fetch(out.target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser,
        template_id: config.wechat.classReminderTplId || "diag-invalid-template",
        page: "pages/index/index",
        // 直接复用真实构造逻辑：字段名与实现永远同步，字段错会返回 47003
        data: buildClassReminderData({
          schedule: {
            courseName: "诊断课程",
            scheduleDate: new Date(),
            startTime: new Date(),
            studio: { name: "诊断舞室" },
            coach: { name: "诊断老师" },
          },
        }),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    out.errcode = j.errcode ?? 0;
    out.errmsg = j.errmsg || "ok";
    out.verdict = CHANNEL_ERRCODES.has(j.errcode)
      ? "通道未生效：控制台「云调用 → 配置接口」需加入 /cgi-bin/message/subscribe/send，且改完要重建版本"
      : j.errcode === 40037
        ? "模板 ID 不被微信认可：检查环境变量 WX_CLASS_REMINDER_TMPL"
        : j.errcode === 47003
          ? "模板字段不匹配：buildClassReminderData 的键名与后台模板详情不一致"
          : j.errcode === 40003
            ? "✅ 云调用生效 + 模板 ID 有效（invalid openid 是自检故意传错的）"
            : j.errcode === 43101
              ? "✅ 参数已通过微信校验，只差用户授权（用户未订阅或已取消授权）"
              : "云调用已生效（返回参数类错误，属预期）";
  } catch (e) {
    out.errmsg = String(e?.message || e);
    out.verdict = "云调用不可达：容器内 http://api.weixin.qq.com 请求失败";
  }
  out.ms = Date.now() - t0;

  res.json(out);
});

export default router;