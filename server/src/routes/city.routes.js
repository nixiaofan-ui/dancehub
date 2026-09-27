import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok } from "../utils/response.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { region } = req.query;
    const where = region ? { region } : {};
    // 带上每个城市的可见门店数（发现页城市切换器显示用）
    const cities = await prisma.city.findMany({
      where,
      orderBy: { id: "asc" },
      include: { _count: { select: { studios: { where: { status: true } } } } },
    });
    ok(
      res,
      cities
        .map((c) => ({
          id: c.id,
          region: c.region,
          name: c.name,
          studioCount: c._count.studios,
        }))
        .filter((c) => c.studioCount > 0)
        // 横滑 chip 条上百来个城市，按门店数排，热门城市才不会被埋在最后
        .sort((a, b) => b.studioCount - a.studioCount),
    );
  }),
);

export default router;