import express from "express";
import healthRoutes from "./routes/health.routes.js";
import authRoutes from "./routes/auth.routes.js";
import calendarRoutes from "./routes/calendar.routes.js";
import cityRoutes from "./routes/city.routes.js";
import studioRoutes from "./routes/studio.routes.js";
import coachRoutes from "./routes/coach.routes.js";
import scheduleRoutes from "./routes/schedule.routes.js";
import followRoutes from "./routes/follow.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import reminderRoutes from "./routes/reminder.routes.js";
import studioWatchRoutes from "./routes/studio-watch.routes.js";
import timelineRoutes from "./routes/timeline.routes.js";
import blockedRoutes from "./routes/blocked.routes.js";
import coachFollowRoutes from "./routes/coach-follow.routes.js";
import reportRoutes from "./routes/report.routes.js";
import importRoutes from "./routes/import.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import configRoutes from "./routes/config.routes.js";
import crawlerRoutes from "./crawler/routes.js";
import { tagEntry } from "./middleware/entry.js";
import { securityHeaders, makeRateLimit, corsWhitelist } from "./middleware/security.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(securityHeaders);
  // 白名单版 CORS：无 Origin（小程序/curl/日历 App）直接过；
  // 浏览器跨域按白名单发头 —— localhost/私网放行（开发），外部站点收不到 CORS 头。
  app.use(corsWhitelist);
  // 全局限流：正常用户一分钟也就几十个请求，300/5min 只会打到脚本和爬虫
  app.use("/api", makeRateLimit({ windowMs: 5 * 60 * 1000, max: 300 }));
  app.use(express.json());
  // 入口判定：给每个请求打上 req.entry（网关 / 公网）。
  // ⚠ 这是**分流标签，不是鉴权** —— 公网请求可以完整伪造 x-wx-* 头，
  //   所以任何「只有 req.entry==='gateway' 才安全」的前提都不成立。详见 middleware/entry.js。
  app.use(tagEntry);

  app.use("/api", healthRoutes);
  // 登录单独收紧：code2session 烧微信配额，不能只靠全局限流兜底
  const authLimiter = makeRateLimit({ windowMs: 5 * 60 * 1000, max: 40 });
  app.use("/api/auth", authLimiter, authRoutes);
  // 日历订阅：无鉴权（token 即凭证），必须挂在 auth 之外 —— 日历 App 不带请求头
  app.use("/api/calendar", calendarRoutes);
  app.use("/api/cities", cityRoutes);
  app.use("/api/studios", studioRoutes);
  app.use("/api/coaches", coachRoutes);
  app.use("/api/schedules", scheduleRoutes);
  app.use("/api/follows", followRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/reminders", reminderRoutes);
  app.use("/api/studio-watches", studioWatchRoutes);
  app.use("/api/timeline", timelineRoutes);
  app.use("/api/blocked", blockedRoutes);
  app.use("/api/coach-follows", coachFollowRoutes);
  app.use("/api/reports", reportRoutes);
  app.use("/api/imports", importRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/config", configRoutes);
  app.use("/api/crawler", crawlerRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}