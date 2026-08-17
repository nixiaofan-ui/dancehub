import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { cityId, keyword } = req.query;
    const where = {};
    if (cityId) where.cityId = Number(cityId);
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { address: { contains: keyword } },
      ];
    }
    const studios = await prisma.studio.findMany({
      where,
      include: { city: true, _count: { select: { schedules: true, coaches: true } } },
      orderBy: { id: "desc" },
    });
    ok(res, studios);
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const studio = await prisma.studio.findUnique({
      where: { id: Number(req.params.id) },
      include: { city: true, coaches: true },
    });
    if (!studio) return fail(res, 404, "舞室不存在");
    ok(res, studio);
  }),
);

router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { cityId, name, address, contact, logoUrl, platform, status } = req.body || {};
    if (!cityId || !name) return fail(res, 400, "cityId 和 name 必填");
    const studio = await prisma.studio.create({
      data: {
        cityId: Number(cityId),
        name,
        address: address || null,
        contact: contact || null,
        logoUrl: logoUrl || null,
        platform: platform || "WECHAT",
        status: status !== undefined ? Boolean(status) : true,
      },
    });
    ok(res, studio, "创建成功");
  }),
);

router.put(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { cityId, name, address, contact, logoUrl, platform, status } = req.body || {};
    const data = {};
    if (cityId !== undefined) data.cityId = Number(cityId);
    if (name !== undefined) data.name = name;
    if (address !== undefined) data.address = address;
    if (contact !== undefined) data.contact = contact;
    if (logoUrl !== undefined) data.logoUrl = logoUrl;
    if (platform !== undefined) data.platform = platform;
    if (status !== undefined) data.status = Boolean(status);

    const studio = await prisma.studio.update({
      where: { id: Number(req.params.id) },
      data,
    });
    ok(res, studio, "更新成功");
  }),
);

router.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const studio = await prisma.studio.update({
      where: { id: Number(req.params.id) },
      data: { status: false },
    });
    ok(res, { id: studio.id }, "已停用");
  }),
);

export default router;