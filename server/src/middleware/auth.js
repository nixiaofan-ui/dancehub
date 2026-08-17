import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { fail } from "../utils/response.js";

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) return fail(res, 401, "未登录");

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.sub;
    req.openid = payload.openid;
    next();
  } catch {
    return fail(res, 401, "登录已过期，请重新登录");
  }
}