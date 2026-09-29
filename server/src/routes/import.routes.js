import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ok, fail } from "../utils/response.js";
import {
  parseDateKey,
  invalidateTimelineCache,
} from "../services/schedule.service.js";
import { computeRemindAt } from "../services/reminder.service.js";
import { invalidateStudioIndex } from "../lib/studio-index.js";

const router = Router();

/**
 * 城市名归一化：用户手输的 cityName 可能带行政后缀（「三亚市」「湘西土家族苗族自治州」），
 * 不统一就会和库里已有的「三亚」建成两条，于是同一座城市出现两遍。
 * 只剥标准的行政后缀，不动前缀（「张家界市」剥完是「张家界」，不会被误伤成别的地方）。
 */
function normalizeCityName(raw) {
  return String(raw || "")
    .trim()
    .replace(/[（(].*?[)）]/g, "")
    .replace(/(市|自治州|地区|盟|特别行政区|自治县|县)$/g, "")
    .trim();
}

/**
 * 取（或建）城市。
 *
 * 为什么允许建库里没有的城市：录入是为「我们没抓到的地方」兜底的，
 * 而没抓到的地方往往连城市都不在库里（用户就在三亚，库里只有北上广）。
 * 这时若强行落到当前城市，三亚的课会算到上海名下 —— 用户一看就知道是错的。
 * 建城市的成本只有一行，而数据错位的成本是整座城市的课都不可信。
 */
async function resolveCity(cityId, cityName, regionHint) {
  const region = regionHint === "OVERSEAS" ? "OVERSEAS" : "CN";
  const id = Number(cityId);
  if (Number.isFinite(id) && id > 0) {
    const hit = await prisma.city.findFirst({ where: { id }, select: { id: true } });
    if (hit) return { id: hit.id, created: false };
  }
  const name = normalizeCityName(cityName);
  if (!name) return null;

  // 同城不同写法复用：先精确、再去后缀模糊比一次，避免「三亚」和「三亚市」裂成两个城市
  let city =
    (await prisma.city.findFirst({ where: { region, name }, select: { id: true } })) ||
    (await prisma.city.findFirst({
      where: { region, name: normalizeCityName(name) },
      select: { id: true },
    }));
  if (!city) {
    city = await prisma.city.create({ data: { region, name }, select: { id: true } });
    return { id: city.id, created: true, name };
  }
  return { id: city.id, created: false, name };
}

/**
 * 用户手工录入课表：POST /api/imports/schedule
 *
 * 存在的理由：抓取只能覆盖用了那几套 SaaS 的店，头部独立舞室永远有漏，
 * 而这些恰恰是用户最想看的。与其我们一家家逆向，不如让用户自己录。
 *
 * 刻意做成「结构化逐条录入」而不是「粘贴文本自动解析」：
 * 各家公众号的课表排版五花八门（有的用 emoji 分隔、有的周视图横排、
 * 有的把教练写在课名里），自动解析看着聪明，解错了却没人会发现 ——
 * 课表这种数据，宁可录入慢一点，也不能错。
 *
 * 可见性：ownerId = 当前用户，只有本人能看见（抓取来的公共课 ownerId 为 null）。
 * 一开始默认写进公共库，后来改私有 —— 手录的内容没有任何校验，
 * 放公共库等于让所有人为一个人的录入质量买单；而「录给自己看」
 * 本来就是主要场景（补上那家没被抓取覆盖的店）。
 * 门店仍是公共的：门店只是个名字，不涉及对错，别人搜到同名店还能复用。
 */
router.post(
  "/schedule",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const studioName = String(body.studioName || "").trim();
    const dateKey = String(body.date || "").trim();
    const startTime = String(body.startTime || "").trim();
    const endTime = String(body.endTime || "").trim();
    const courseName = String(body.courseName || "").trim();
    const coachName = String(body.coachName || "").trim();

    if (!studioName || !dateKey || !startTime || !courseName) {
      return fail(res, 400, "门店、日期、开始时间、课程名必填");
    }

    // 城市二选一：cityId（库里已有，前端城市面板选的）或 cityName（库外城市，用户手输）
    const city = await resolveCity(body.cityId, body.cityName, body.region);
    if (!city) return fail(res, 400, "缺少城市");
    const cityId = city.id;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return fail(res, 400, "日期格式应为 YYYY-MM-DD");
    if (!/^\d{2}:\d{2}$/.test(startTime)) return fail(res, 400, "时间格式应为 HH:MM");
    if (endTime && !/^\d{2}:\d{2}$/.test(endTime)) return fail(res, 400, "时间格式应为 HH:MM");

    const endTimeFinal = endTime || startTime;

    // 同名门店复用 —— 同城同名大概率就是同一家，
    // 建重了会变成两家都只有一半课的鬼影门店
    let studio = await prisma.studio.findFirst({
      where: { cityId, name: studioName },
      select: { id: true },
    });
    let studioCreated = false;
    if (!studio) {
      studio = await prisma.studio.create({
        data: { cityId, name: studioName, platform: "OTHER", status: true },
        select: { id: true },
      });
      studioCreated = true;
      // 新补录的门店要能立刻被搜到（索引有 10 分钟 TTL）
      invalidateStudioIndex();
    }

    // 教练同理：Coach 挂在门店下，换家店就得重认
    let coachId = null;
    if (coachName) {
      let coach = await prisma.coach.findFirst({
        where: { studioId: studio.id, name: coachName },
        select: { id: true },
      });
      if (!coach) {
        coach = await prisma.coach.create({
          data: { studioId: studio.id, name: coachName },
          select: { id: true },
        });
      }
      coachId = coach.id;
    }

    // 补录实际上是两件事：加一节课 + 记一下我打算怎么处理它。
    //
    // 旧实现只做第一件，于是补录完还得回课表再点一次「预约」，
    // 「我录过的课」在预约记录里永远查不到 —— 而专程跑来补录一节课的人
    // 本来就是打算去上它，让他多点一次按钮纯粹是把自己的绕路当成用户的流程。
    //
    // 三选一（前端单选组）：
    //   CONFIRMED = 已约（在店里已经约好了）
    //   PENDING   = 想上（先记着，顺手开课前提醒）
    //   其他/空   = 只记录，不约也不提醒
    const book = String(body.book || "").toUpperCase();
    const wantBooking = book === "CONFIRMED" || book === "PENDING";

    // 课程、预约、提醒必须一起成功或一起不算 —— 中间断一次会留下一条
    // 用户以为约好了、实际只有个空壳的课。
    const made = await prisma.$transaction(async (tx) => {
      const schedule = await tx.schedule.create({
        data: {
          studioId: studio.id,
          coachId,
          courseName,
          difficulty: body.difficulty || "ALL_LEVELS",
          scheduleDate: parseDateKey(dateKey),
          startTime: new Date(`1970-01-01T${startTime}:00`),
          endTime: new Date(`1970-01-01T${endTimeFinal}:00`),
          remark: body.remark || "用户录入",
          ownerId: req.userId,
        },
      });

      let booking = null;
      if (wantBooking) {
        booking = await tx.booking.create({
          data: {
            userId: req.userId,
            scheduleId: schedule.id,
            status: book === "CONFIRMED" ? "CONFIRMED" : "PENDING",
            method: "MANUAL",
          },
        });
      }

      // 「想上」顺手开一条本地提醒。不建订阅消息是刻意的：
      // 订阅必须用户当场点同意，服务端没法替他授权，偷塞一条只会发不出去。
      let reminder = null;
      if (book === "PENDING") {
        reminder = await tx.reminder.create({
          data: {
            userId: req.userId,
            scheduleId: schedule.id,
            remindAt: computeRemindAt(schedule),
            status: "PENDING",
            subscribeTplId: null,
            type: "LOCAL",
          },
        });
      }
      return { schedule, booking, reminder };
    });

    await invalidateTimelineCache();

    let msg =
      book === "CONFIRMED"
        ? "已录入，并标记为已约"
        : book === "PENDING"
          ? "已录入，想上的课已开好提醒"
          : "已录入";
    if (studioCreated) msg += `，新建了门店「${studioName}」`;
    else if (city.created) msg += `，新建了城市「${city.name}」`;

    ok(
      res,
      {
        id: made.schedule.id,
        studioId: studio.id,
        studioCreated,
        cityId,
        cityCreated: !!city.created,
        bookingId: made.booking ? made.booking.id : null,
        bookingStatus: made.booking ? made.booking.status : null,
        reminderId: made.reminder ? made.reminder.id : null,
      },
      msg,
    );
  }),
);

/**
 * 我录过的课：GET /api/imports/mine
 * 录入是私有的，所以必须有个地方能回看/删掉 —— 只让录不让删，
 * 填错日期的人只能干看着一条永远出现在错误日期的课。
 */
router.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const rows = await prisma.schedule.findMany({
      where: { ownerId: uid },
      include: {
        studio: { include: { city: true } },
        coach: true,
        // 预约状态跟着一起回：前端要在一行里同时显示「我录的」和「已约 / 想上 / 只记录」，
        // 再让用户自己去两个列表里比对显然不合理。
        // 带 userId 条件是因为别人的预约不该出现在我这儿。
        bookings: { where: { userId: uid } },
        reminders: { where: { userId: uid } },
      },
      orderBy: [{ scheduleDate: "asc" }, { startTime: "asc" }],
    });

    ok(
      res,
      rows.map((s) => ({
        id: s.id,
        courseName: s.courseName,
        date: s.scheduleDate.toISOString().slice(0, 10),
        startTime: s.startTime.toTimeString().slice(0, 5),
        endTime: s.endTime.toTimeString().slice(0, 5),
        coachName: s.coach ? s.coach.name : "",
        studioName: s.studio.name,
        cityId: s.studio.city ? s.studio.city.id : null,
        cityName: s.studio.city ? s.studio.city.name : "",
        difficulty: s.difficulty,
        bookingStatus: s.bookings.length ? s.bookings[0].status : null,
        bookingId: s.bookings.length ? s.bookings[0].id : null,
        hasReminder: s.reminders.length > 0,
      }))
    );
  }),
);

/**
 * 「我的城市」：GET /api/imports/cities
 *
 * 用户录入过的城市，按课数倒序。存在的理由：
 * 录入经常发生在**库里没有的城市**（用户人在三亚，我们只接了北上广）。
 * 这类城市如果不在任何入口露出来，用户录完就找不回去了
 * —— 课在库里，但切换城市时压根没有「三亚」这个选项。
 * 这里把「我录过课的城市」单独列一份，既是对录入的回执，
 * 也是那些**还没被抓取覆盖的城市**的唯一入口。
 */
router.get(
  "/cities",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await prisma.schedule.findMany({
      where: { ownerId: req.userId },
      include: { studio: { include: { city: true } } },
    });

    const map = new Map();
    for (const s of rows) {
      const city = s.studio && s.studio.city;
      if (!city) continue;
      const hit = map.get(city.id);
      if (hit) {
        hit.count += 1;
      } else {
        map.set(city.id, {
          id: city.id,
          name: city.name,
          region: city.region,
          count: 1,
        });
      }
    }

    ok(
      res,
      [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"))
    );
  }),
);

/**
 * 删除自己录的课：DELETE /api/imports/schedule/:id
 *
 * ⚠ 必须先把引用它的记录删干净。Booking / Reminder 对 Schedule 都是必填外键，
 *   而 schema 没配 onDelete: Cascade（Prisma 默认 Restrict）——
 *   以前这里直接 deleteMany Schedule，于是「删一节已经约过的录入课」必定被外键拦下来，
 *   界面只丢出一句莫名其妙的失败。
 *   不去改 schema 加级联有两个理由：云库跑 DDL 要额外走一次迁移；
 *   而应用层显式删能把「删了什么」如实告诉用户。
 *
 * 顺带照顾第二种诉求：用户取消完预约，往往也想把这条自己录的课从课表里抹掉，
 *   所以这里的删除必须包含预约与提醒，而不是只动课程本身。
 */
router.delete(
  "/schedule/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return fail(res, 400, "id 非法");

    // 先按 ownerId 确认归属：不是自己录的课，连动的资格都没有
    const owned = await prisma.schedule.findFirst({
      where: { id, ownerId: req.userId },
      select: { id: true },
    });
    if (!owned) return fail(res, 404, "没找到这条记录，或它不是你录的");

    const removed = await prisma.$transaction(async (tx) => {
      // 这里按 scheduleId 全量删（不限 userId）：一条私有课理论上只可能被本人预约，
      // 但万一存在历史脏数据，留一条指向不存在课程的预约会让 /bookings 整个接口炸掉。
      const b = await tx.booking.deleteMany({ where: { scheduleId: id } });
      const r = await tx.reminder.deleteMany({ where: { scheduleId: id } });
      const s = await tx.schedule.deleteMany({ where: { id, ownerId: req.userId } });
      return { bookings: b.count, reminders: r.count, schedules: s.count };
    });

    await invalidateTimelineCache();
    ok(
      res,
      { id, ...removed },
      removed.bookings || removed.reminders ? "已删除，相关预约和提醒也一并清掉了" : "已删除",
    );
  }),
);

export default router;
