import { config } from "../config.js";
import { fail } from "../utils/response.js";

export function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== config.adminToken) {
    return fail(res, 403, "无管理员权限");
  }
  next();
}