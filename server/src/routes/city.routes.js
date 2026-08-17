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
    const cities = await prisma.city.findMany({
      where,
      orderBy: { id: "asc" },
    });
    ok(res, cities);
  }),
);

export default router;