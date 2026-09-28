import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

/**
 * 用户屏蔽的老师名单（产品文案「不想看」）。
 *
 * 为什么能在这儿用 req.userId 直接查：屏蔽是纯偏好数据，
 * 不涉及别人的信息，不需要额外的权限校验。
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await prisma.coachBlock.findMany({
      where: { userId: req.userId },
      select: { coachName: true },
      orderBy: { createdAt: "desc" },
    });
    ok(res, rows.map((r) => r.coachName));
  }),
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const name = String((req.body || {}).name || "").trim();
    if (!name) return fail(res, 400, "教练名不能为空");
    if (name.length > 60) return fail(res, 400, "教练名太长了");

    await prisma.coachBlock.upsert({
      where: { userId_coachName: { userId: req.userId, coachName: name } },
      create: { userId: req.userId, coachName: name },
      update: {},
    });
    ok(res, { name }, `已不再展示「${name}」的课`);
  }),
);

router.delete(
  "/:name",
  requireAuth,
  asyncHandler(async (req, res) => {
    const name = decodeURIComponent(req.params.name || "");
    if (!name) return fail(res, 400, "教练名不能为空");
    await prisma.coachBlock
      .delete({
        where: { userId_coachName: { userId: req.userId, coachName: name } },
      })
      .catch(() => null); // 本来就没有，删了也是同样的结果
    ok(res, { name }, "已恢复展示");
  }),
);

export default router;
