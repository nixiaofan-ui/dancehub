import { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { ok } from "../utils/response.js";

const router = Router();

router.get("/subscribe", requireAuth, (_req, res) => {
  ok(res, {
    classReminderTplId: config.wechat.classReminderTplId,
    subscribeConfigured: Boolean(config.wechat.appId && config.wechat.appSecret),
  });
});

export default router;