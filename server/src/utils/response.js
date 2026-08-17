export function ok(res, data = null, message = "ok") {
  res.json({ code: 0, message, data });
}

export function fail(res, status, message, data = null) {
  res.status(status).json({ code: status, message, data });
}