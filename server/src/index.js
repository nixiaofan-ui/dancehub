import "dotenv/config";
import { createApp } from "./app.js";
import { redis } from "./lib/redis.js";
import { startReminderJob } from "./jobs/reminder.job.js";

const port = Number(process.env.PORT || 3000);

const app = createApp();

app.listen(port, () => {
  console.log(`[dancehub] API listening on http://localhost:${port}`);

  redis
    .connect()
    .then(() => {
      console.log("[dancehub] Redis connected");
      startReminderJob();
    })
    .catch((err) =>
      console.warn(`[dancehub] Redis unavailable (${err.message}); API still serving`),
    );
});