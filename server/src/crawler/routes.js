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
  tickOnce,
  dueCount,
  probeOutbound,
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

// 出口连通性自检：容器能不能访问外网 / 抓取目标站点。
// 不加鉴权：返回值只有「通不通」和 HTTP 状态码，没有密钥等敏感信息，
// 而排查问题时往往需要在没带 token 的情况下直接 curl 一下。
router.get("/probe", asyncHandler(async (req, res) => ok(res, await probeOutbound())));

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

// 定时触发器入口（云托管控制台配 cron 调用；服务未开外网，仅平台侧可达）。
// 立即返回，抓取在后台跑；防重入——上一轮没跑完时本次直接跳过。
router.post("/tick", (req, res) => {
  const due = dueCount();
  tickOnce("cloud-trigger")
    .then((r) => {
      if (!r.started) console.log(`[crawler] 触发器跳过：${r.reason}`);
    })
    .catch((e) => console.error("[crawler] 触发器执行异常:", e.message));
  ok(res, { started: true, due, note: "后台抓取已受理，进度见 GET /api/crawler/status" });
});

export default router;
