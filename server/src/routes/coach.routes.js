import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { studioId } = req.query;
    const where = studioId ? { studioId: Number(studioId) } : {};
    const coaches = await prisma.coach.findMany({
      where,
      include: { studio: { select: { id: true, name: true } } },
      orderBy: { id: "desc" },
    });
    ok(res, coaches);
  }),
);

router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { studioId, name, avatarUrl } = req.body || {};
    if (!studioId || !name) return fail(res, 400, "studioId 和 name 必填");
    const coach = await prisma.coach.create({
      data: { studioId: Number(studioId), name, avatarUrl: avatarUrl || null },
    });
    ok(res, coach, "创建成功");
  }),
);

router.put(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { studioId, name, avatarUrl } = req.body || {};
    const data = {};
    if (studioId !== undefined) data.studioId = Number(studioId);
    if (name !== undefined) data.name = name;
    if (avatarUrl !== undefined) data.avatarUrl = avatarUrl;

    const coach = await prisma.coach.update({ where: { id: Number(req.params.id) }, data });
    ok(res, coach, "更新成功");
  }),
);

router.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await prisma.coach.delete({ where: { id: Number(req.params.id) } });
    ok(res, null, "删除成功");
  }),
);

export default router;