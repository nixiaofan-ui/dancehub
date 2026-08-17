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
import timelineRoutes from "./routes/timeline.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import configRoutes from "./routes/config.routes.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use("/api", healthRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/cities", cityRoutes);
  app.use("/api/studios", studioRoutes);
  app.use("/api/coaches", coachRoutes);
  app.use("/api/schedules", scheduleRoutes);
  app.use("/api/follows", followRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/reminders", reminderRoutes);
  app.use("/api/timeline", timelineRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/config", configRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}