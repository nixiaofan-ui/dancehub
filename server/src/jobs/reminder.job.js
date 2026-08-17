import cron from "node-cron";
import { sendDueReminders } from "../services/reminder.service.js";

export function startReminderJob() {
  cron.schedule("* * * * *", async () => {
    try {
      await sendDueReminders();
    } catch (e) {
      console.error("[dancehub] reminder job error:", e.message);
    }
  });
  console.log("[dancehub] reminder job scheduled (every minute)");
}