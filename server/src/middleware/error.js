import { fail } from "../utils/response.js";

export function notFoundHandler(_req, res) {
  fail(res, 404, "接口不存在");
}

export function errorHandler(err, _req, res, _next) {
  if (err.code === "P2002") {
    return fail(res, 409, "数据已存在（唯一约束冲突）");
  }
  if (err.code === "P2025") {
    return fail(res, 404, "记录不存在");
  }
  if (err.message?.includes("timed out")) {
    return fail(res, 500, "数据库请求超时");
  }
  console.error("[dancehub] unhandled error:", err);
  fail(res, 500, "服务器内部错误");
}