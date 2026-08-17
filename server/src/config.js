import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  jwtSecret: process.env.JWT_SECRET || "dev-secret-do-not-use-in-prod",
  adminToken: process.env.ADMIN_TOKEN || "admin123",
  wechat: {
    appId: process.env.WECHAT_APPID || "",
    appSecret: process.env.WECHAT_SECRET || "",
    classReminderTplId: process.env.WX_CLASS_REMINDER_TMPL || "",
  },
};

export const isDev = () => config.nodeEnv === "development";