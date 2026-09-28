import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

/**
 * 用户标记的「常看的老师」（产品文案：爱师）。
 *
 * 与 blocked.routes.js 是同一套写法的反向偏好：那边是「别让我看见」，
 * 这边是「有他的课先给我看」。同样只存名字、不存 coachId ——
 * 同一个老师在不同门店是两条 Coach 记录，按 id 关注只能关注到其中一家店的课。
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await prisma.coachFollow.findMany({
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

    await prisma.coachFollow.upsert({
      where: { userId_coachName: { userId: req.userId, coachName: name } },
      create: { userId: req.userId, coachName: name },
      update: {},
    });
    ok(res, { name }, `已把「${name}」加入常看`);
  }),
);

router.delete(
  "/:name",
  requireAuth,
  asyncHandler(async (req, res) => {
    const name = decodeURIComponent(req.params.name || "");
    if (!name) return fail(res, 400, "教练名不能为空");
    await prisma.coachFollow
      .delete({
        where: { userId_coachName: { userId: req.userId, coachName: name } },
      })
      .catch(() => null);
    ok(res, { name }, "已移出常看");
  }),
);

export default router;
