import { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { ok } from "../utils/response.js";
import { subscribeConfigured } from "../services/reminder.service.js";

const router = Router();

router.get("/subscribe", requireAuth, (_req, res) => {
  ok(res, {
    classReminderTplId: config.wechat.classReminderTplId,
    // 没配模板 ID 时小程序端不该让用户去授权 —— 授了也发不出去
    subscribeConfigured: subscribeConfigured(),
  });
});

export default router;