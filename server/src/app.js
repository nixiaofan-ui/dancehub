import express from "express";
import cors from "cors";
import healthRoutes from "./routes/health.routes.js";
import authRoutes from "./routes/auth.routes.js";
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
import { notFoundHandler, errorHandler } from "./middleware/error.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  // 入口判定：给每个请求打上 req.entry（网关 / 公网）。
  // ⚠ 这是**分流标签，不是鉴权** —— 公网请求可以完整伪造 x-wx-* 头，
  //   所以任何「只有 req.entry==='gateway' 才安全」的前提都不成立。详见 middleware/entry.js。
  app.use(tagEntry);

  app.use("/api", healthRoutes);
  app.use("/api/auth", authRoutes);
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