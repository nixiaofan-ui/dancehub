import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../utils/async-handler.js";
import { buildCalendarIcs } from "../lib/calendar-ics.js";

/**
 * 手机日历订阅端点（公开）：
 *   GET /api/calendar/<calToken>.ics
 *
 * 日历 App（iOS 订阅日历 / macOS 日历 / Google 日历）拉取时不会带任何请求头，
 * 鉴权只能靠 URL 里的随机 token（48 hex）。泄露的最坏后果 = 看到提醒课表，
 * 不含任何账号凭据，可接受；被滥用时在库侧换 token 即可作废旧链接。
 * 数据源 = 网页端通过 /auth/calendar-sync 镜像上来的本机提醒。
 */
const router = Router();

router.get(
  "/:token.ics",
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || "").toLowerCase();
    if (!/^[0-9a-f]{24,64}$/.test(token)) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    const user = await prisma.user.findUnique({
      where: { calToken: token },
      select: { calReminders: true },
    });
    if (!user) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(buildCalendarIcs(user.calReminders));
  })
);

export default router;
