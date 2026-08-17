import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { pingRedis } from "../lib/redis.js";

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

export default router;