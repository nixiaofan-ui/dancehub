import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

/**
 * 用户提报缺失的舞室。
 *
 * 抓取能覆盖的天花板由「这家用没用那几套 SaaS」决定，头部独立舞室永远有漏，
 * 而猜哪些该补是件回报很低的事。让用户直接告诉我们缺谁，
 * 这条名单比自己爬准得多，也顺手成了接入队列。
 *
 * 允许匿名提交：多一层登录门槛，反馈率就掉一层。
 */
router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) return fail(res, 400, "请填写舞室名称");
    if (name.length > 60) return fail(res, 400, "名称太长了");

    const row = await prisma.studioReport.create({
      data: {
        userId: req.userId || null,
        name,
        city: body.city ? String(body.city).slice(0, 60) : null,
        contact: body.contact ? String(body.contact).slice(0, 60) : null,
        comment: body.comment ? String(body.comment).slice(0, 500) : null,
      },
    });

    ok(res, { id: row.id }, "收到啦，我们会尽快补上");
  }),
);

/** 自家友军查看待办队列：按未处理优先 */
router.get(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = req.query.status || "PENDING";
    const rows = await prisma.studioReport.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    ok(res, rows);
  }),
);

router.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = String((req.body || {}).status || "");
    if (!["PENDING", "DONE", "REJECTED"].includes(status)) {
      return fail(res, 400, "status 只能是 PENDING / DONE / REJECTED");
    }
    const row = await prisma.studioReport.update({
      where: { id: Number(req.params.id) },
      data: { status },
    });
    ok(res, row, "已更新");
  }),
);

export default router;
