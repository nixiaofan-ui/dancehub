import { Router } from "express";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import {
  getCrawlerConfig,
  listCrawlerConfigs,
  runCrawl,
  runAllCrawls,
  getCrawlStatus,
} from "./index.js";

const router = Router();

// 配置
router.get("/configs", requireAdmin, (req, res) => ok(res, listCrawlerConfigs()));

router.get("/configs/:id", requireAdmin, (req, res) => {
  const c = getCrawlerConfig(req.params.id);
  if (!c) return fail(res, 404, "配置不存在");
  ok(res, c);
});

// 状态（最近一次运行结果）
router.get("/status", requireAdmin, (req, res) => ok(res, getCrawlStatus()));

// 手动触发：POST /api/crawler/run            → 跑全部启用配置
//           POST /api/crawler/run { ids }    → 跑指定配置
//           POST /api/crawler/run/:id        → 跑单个配置
// body 可选 { dryRun: true } → 只抓取不写入
router.post("/run", requireAdmin, asyncHandler(async (req, res) => {
  const { ids, dryRun } = req.body || {};
  if (Array.isArray(ids) && ids.length) {
    const results = [];
    for (const id of ids) {
      try {
        results.push(await runCrawl(id, { dryRun }));
      } catch (e) {
        results.push({ configId: id, error: e.message });
      }
    }
    return ok(res, results);
  }
  ok(res, await runAllCrawls({ dryRun }));
}));

router.post("/run/:id", requireAdmin, asyncHandler(async (req, res) => {
  const { dryRun } = req.body || {};
  ok(res, await runCrawl(req.params.id, { dryRun }), "抓取完成");
}));

export default router;
