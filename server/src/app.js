import express from "express";
import cors from "cors";
import healthRoutes from "./routes/health.routes.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use("/api", healthRoutes);

  return app;
}