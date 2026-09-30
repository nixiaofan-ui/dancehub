import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import { toDateKey } from "../services/schedule.service.js";
import {
  sendDueReminders,
  computeRemindAt,
  parseUserDateTime,
  toLocalText,
  REMIND_KINDS,
} from "../services/reminder.service.js";

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const reminders = await prisma.reminder.findMany({
      where: { userId: req.userId },
      include: {
        schedule: {
          include: { studio: { include: { city: true } }, coach: true },
        },
      },
      orderBy: { remindAt: "asc" },
    });
    ok(
      res,
      reminders.map((r) => ({
        id: r.id,
        status: r.status,
        type: r.type,
        kind: r.kind,
        // 前端要拼「10月5日 12:00 提醒你去抢」，给字符串比让它自己转时区省心
        remindAt: r.remindAt,
        remindAtLocal: toLocalText(r.remindAt),
        schedule: {
          id: r.schedule.id,
          courseName: r.schedule.courseName,
          scheduleDate: toDateKey(r.schedule.scheduleDate),
          startTime: r.schedule.startTime.toTimeString().slice(0, 5),
          coach: r.schedule.coach?.name || null,
          studio: r.schedule.studio.name,
          city: r.schedule.studio.city?.name || null,
        },
      })),
    );
  }),
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { scheduleId, subscribe, kind = "CLASS", remindAt } = req.body || {};
    if (!scheduleId) return fail(res, 400, "scheduleId 必填");
    if (!REMIND_KINDS.includes(kind)) return fail(res, 400, "kind 只能是 CLASS 或 SNIPE");

    const schedule = await prisma.schedule.findUnique({ where: { id: Number(scheduleId) } });
    if (!schedule) return fail(res, 404, "课程不存在");

    // 时刻的两个来源：开课提醒由服务端按「课前 2 小时」算，抢课闹钟必须由用户指定 ——
    // 各家舞室几点放名额既没有统一规律，也没有任何平台接口给这个值，服务端算不出来。
    let at;
    if (kind === "SNIPE") {
      at = parseUserDateTime(remindAt);
      if (!at) return fail(res, 400, "抢课闹钟需要指定 remindAt（YYYY-MM-DD HH:mm，北京时间）");
      // 留给理性的边界：抢课闹钟早于「现在」没有意义，设了也是立刻被作废
      if (at.getTime() <= Date.now()) return fail(res, 400, "提醒时刻要晚于现在");
    } else {
      at = computeRemindAt(schedule);
    }

    // 仅当用户授权订阅且已配置模板时，才走订阅消息推送
    const subscribeTplId =
      subscribe && config.wechat.classReminderTplId ? config.wechat.classReminderTplId : null;
    const common = {
      remindAt: at,
      status: "PENDING",
      sentAt: null,
      subscribeTplId,
      type: subscribeTplId ? "SUBSCRIBE" : "LOCAL",
    };

    // ⚠ 唯一键是 (userId, scheduleId, kind)：抢课闹钟不能把开课提醒顶掉，反之亦然
    const reminder = await prisma.reminder.upsert({
      where: {
        userId_scheduleId_kind: { userId: req.userId, scheduleId: Number(scheduleId), kind },
      },
      update: common,
      create: { userId: req.userId, scheduleId: Number(scheduleId), kind, ...common },
    });

    const what = kind === "SNIPE" ? "抢课闹钟" : "开课提醒";
    ok(
      res,
      { ...reminder, kind: reminder.kind, remindAtLocal: toLocalText(reminder.remindAt) },
      `${what}已开启（${toLocalText(reminder.remindAt)}）` +
        (subscribeTplId ? "，会发订阅消息" : "，小程序内提醒"),
    );
  }),
);

// ⛔ 这里曾有一个 GET /reminders/hint（按门店历史「提前几天放课 + 惯常几点刷到」推算建议时刻），
//   已删除。原因：门店**放出课表**的时间（常常提前一周）和**真正开放预约**的时间（临近几天、
//   热门课要抢）压根不是一回事；而我们的抓取是 6 小时一轮，推算出来的"钟点"其实是我们自己的
//   抓取钟点。把这个当放课时刻给用户，等于让他照着我们编的时间去蹲，抢不到还怪我们不准。
//   → 约课提醒的时刻一律由用户自己填（kind=SNIPE 必填 remindAt）。

router.delete(
  "/:scheduleId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { kind } = req.query || {};
    // 不带 kind = 关掉这节课的所有提醒（老前端只会这样调）
    const where = { userId: req.userId, scheduleId: Number(req.params.scheduleId) };
    if (kind && REMIND_KINDS.includes(String(kind))) where.kind = String(kind);
    const r = await prisma.reminder.deleteMany({ where });
    ok(res, null, r.count ? "已关闭提醒" : "本来就没有提醒");
  }),
);

// 定时触发器入口（云托管控制台配 cron 调用；服务未开外网，仅平台侧可达）。
// 扫描到期提醒并推送订阅消息；跑得快（≤50 条/轮），同步返回结果。
let reminderTicking = false;
router.post(
  "/tick",
  asyncHandler(async (req, res) => {
    if (reminderTicking) return ok(res, { started: false, reason: "already-running" });
    reminderTicking = true;
    try {
      const r = await sendDueReminders();
      ok(res, { started: true, ...r });
    } finally {
      reminderTicking = false;
    }
  }),
);

export default router;