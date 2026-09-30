import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { buildStyleMap } from "../services/studio-style.service.js";

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const follows = await prisma.follow.findMany({
      where: { userId: req.userId },
      include: {
        studio: {
          include: { city: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    // 关注列表要能按舞种筛（「我关注的这些店里，哪几家有 Jazz」），
    // 而舞种不在 Studio 表上，得按未来课表现算 —— 一次 groupBy 覆盖全部关注店。
    const styleMap = await buildStyleMap(follows.map((f) => f.studioId));
    ok(
      res,
      follows.map((f) => ({
        id: f.id,
        createdAt: f.createdAt,
        studio: {
          id: f.studio.id,
          name: f.studio.name,
          address: f.studio.address,
          logoUrl: f.studio.logoUrl,
          platform: f.studio.platform,
          city: f.studio.city?.name,
          region: f.studio.city?.region,
          district: f.studio.district || null,
          // 距离排序要用。没坐标的店给 null，前端一律排在有距离的后面 ——
          // 不会拿城市中心点顶替，那会显示出一个看起来真实、实际是编的距离
          lat: f.studio.lat ?? null,
          lng: f.studio.lng ?? null,
          styles: styleMap.get(f.studio.id) || [],
        },
      })),
    );
  }),
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { studioId } = req.body || {};
    if (!studioId) return fail(res, 400, "studioId 必填");

    const studio = await prisma.studio.findUnique({ where: { id: Number(studioId) } });
    if (!studio) return fail(res, 404, "舞室不存在");

    const follow = await prisma.follow.upsert({
      where: { userId_studioId: { userId: req.userId, studioId: Number(studioId) } },
      update: {},
      create: { userId: req.userId, studioId: Number(studioId) },
    });
    ok(res, follow, "已关注");
  }),
);

router.delete(
  "/:studioId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.follow.deleteMany({
      where: { userId: req.userId, studioId: Number(req.params.studioId) },
    });
    ok(res, null, "已取消关注");
  }),
);

export default router;