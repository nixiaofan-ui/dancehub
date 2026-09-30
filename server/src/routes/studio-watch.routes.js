import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";

const router = Router();

/** 星期几的中文短名，与前端 WEEK_CN 同序（0=周日） */
const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** "12:00" —— 只收 24 小时制的整点分钟，别把 "12:00:00" / "9:00" 放进来 */
function normalizeHhmm(input) {
  const s = String(input || "").trim();
  if (!/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function serialize(w) {
  return {
    id: w.id,
    studioId: w.studioId,
    studioName: w.studio?.name || null,
    cityName: w.studio?.city?.name || null,
    weekday: w.weekday,
    weekdayLabel: WEEK_CN[w.weekday] || "",
    hhmm: w.hhmm,
  };
}

/**
 * 我的门店放课提醒。
 * 带 studioId 时只回那一家（门店页判断「这家店我设过没有」就靠它），
 * 不带时回全部（将来「我的·提醒管理」页直接用这个）。
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const studioId = Number(req.query.studioId) || null;
    const rows = await prisma.studioWatch.findMany({
      where: { userId: req.userId, ...(studioId ? { studioId } : {}) },
      include: { studio: { include: { city: true } } },
      orderBy: { updatedAt: "desc" },
    });
    ok(res, studioId ? rows[0] || null : rows.map(serialize));
  }),
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { studioId } = req.body || {};
    const weekday = Number(req.body && req.body.weekday);
    const hhmm = normalizeHhmm(req.body && req.body.hhmm);
    if (!studioId) return fail(res, 400, "studioId 必填");
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
      return fail(res, 400, "weekday 要是 0(周日)~6(周六)");
    if (!hhmm) return fail(res, 400, "hhmm 格式要像 12:00");

    const studio = await prisma.studio.findUnique({
      where: { id: Number(studioId) },
      select: { id: true, name: true },
    });
    if (!studio) return fail(res, 404, "舞室不存在");

    // 一家店一条：再设一次是"改时间"，不是"又加一条"（唯一键也是这个口径）
    const watch = await prisma.studioWatch.upsert({
      where: { userId_studioId: { userId: req.userId, studioId: Number(studioId) } },
      update: { weekday, hhmm },
      create: { userId: req.userId, studioId: Number(studioId), weekday, hhmm },
      include: { studio: { include: { city: true } } },
    });
    ok(res, serialize(watch), `已设每周${WEEK_CN[weekday]} ${hhmm} 提醒`);
  }),
);

router.delete(
  "/:studioId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const r = await prisma.studioWatch.deleteMany({
      where: { userId: req.userId, studioId: Number(req.params.studioId) },
    });
    // ⚠ 只删得掉我们库里这条。手机日历里那个「每周重复事件」是写进用户自己日历的，
    //   微信没有任何删日历的接口 —— 前端必须如实告诉用户「那条要你自己删」，
    //   否则用户会以为关掉了，下周被响一次还以为是我们没关干净。
    ok(res, { removed: r.count }, r.count ? "已关掉提醒" : "本来就没有提醒");
  }),
);

export default router;
