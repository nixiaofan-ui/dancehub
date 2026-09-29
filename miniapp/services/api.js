const req = require("../utils/request");
const { devDeviceId } = require("../utils/device");

/**
 * 写操作（预约/取消/关注/提醒）会把「课表」页的数据弄脏，这里统一打个计数。
 * 课表页 onShow 拿它跟自己上次看到的数字比，不一样就无条件刷新 ——
 * 否则用户在详情页预约完切回来，列表还是旧的，只能靠切城市触发重刷。
 *
 * 用计数而不是布尔：布尔在多处写操作后会被某一次消费清掉，计数不会漏。
 */
const markDirty = () => {
  try {
    const g = getApp().globalData;
    g.dirty = (g.dirty || 0) + 1;
  } catch (e) {
    /* 非小程序环境（本地脚本）忽略 */
  }
};

async function ensureReady() {
  const app = getApp();
  if (app.globalData.token) return;
  if (app.ready) await app.ready;
}

function apiLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: async (r) => {
        try {
          const data = await req.post("/auth/login", {
            code: r.code,
            devId: devDeviceId(),
          });
          resolve(data);
        } catch (e) {
          reject(e);
        }
      },
      fail: reject,
    });
  });
}

const apiCities = (region) => req.get("/cities", region ? { region } : {});
const apiTimeline = (cityId, date) => req.get("/timeline", { cityId, date });
/**
 * 自选门店组的合并课表（多店视图）。
 * 三个入口共用：品牌多店 / 已关注门店筛选 / 老师主页。
 * @param {number[]} ids 门店 id
 * @param {string} [from] 起始日期；不传=只看今天
 * @param {string} [to] 结束日期；不传=只看 from（或今天）
 */
const apiMultiTimeline = (ids, from, to) =>
  req.get("/timeline/multi", {
    studioIds: (ids || []).join(","),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
const apiBrands = (cityId) => req.get("/studios/brands", { cityId });
const apiStudios = (params) => req.get("/studios", params || {});
const apiStudioDetail = (id) => req.get(`/studios/${id}`);
const apiStudioTodaySchedules = (studioId) =>
  req.get(`/studios/${studioId}/today-schedules`);
const apiStudioSchedules = (studioId, from, to) =>
  req.get("/schedules", { studioId, from, to });
const apiScheduleDetail = (id) => req.get(`/schedules/${id}`);
const apiScheduleVideoPreview = (id) => req.get(`/schedules/${id}/video-preview`);
// 实时回源舞室官方系统取当前真实已约人数（失败会静默降级到库里的旧值）
const apiLiveBooking = (id) => req.get(`/schedules/${id}/live-booking`);
// 周课表/首页用：一次刷完整店当天的预约人数（上面那个一次只解决一节，列表里逐节调太多）
const apiStudioDayLive = (studioId, date) =>
  req.get("/schedules/live-booking", { studioId, date });

const apiFollows = () => req.get("/follows");
const apiFollow = (studioId) => {
  markDirty();
  return req.post("/follows", { studioId });
};
const apiUnfollow = (studioId) => {
  markDirty();
  return req.delete("/follows/" + studioId);
};

// force=true：已知撞课、用户确认后仍要预约（服务端不再拦）
const apiCreateBooking = (scheduleId, method, force) => {
  markDirty();
  return req.post("/bookings", { scheduleId, method, force: Boolean(force) });
};
// 取消预约：服务端会连同一并返回 reminderRemoved，用来提示提醒是否已一并关掉
const apiCancelBooking = (scheduleId) => {
  markDirty();
  return req.delete("/bookings/" + scheduleId);
};
const apiBookings = () => req.get("/bookings");
const apiPendingCount = () => req.get("/bookings/pending-count");

const apiReminders = () => req.get("/reminders");
const apiAddReminder = (scheduleId, subscribe) => {
  markDirty();
  return req.post("/reminders", { scheduleId, subscribe: Boolean(subscribe) });
};
const apiRemoveReminder = (scheduleId) => {
  markDirty();
  return req.delete("/reminders/" + scheduleId);
};
/**
 * 订阅消息配置：拿课程提醒模板 ID，以及「服务端到底配没配」。
 * 没配时小程序端不该弹订阅授权 —— 用户授了也发不出去，等于骗授权。
 *
 * ⚠ 这个函数曾经只剩导出、丢了定义（下方 module.exports 里那一行），
 *   而 module.exports 是模块顶层执行的：名字一旦未定义，整个 api.js
 *   求值就抛 ReferenceError，连带 app.js 与每个页面都注册失败，
 *   界面只剩一片背景色 + 控制台一行 "Page ... has not been registered yet"。
 *   改完本文件请跑 npm run check:register。
 */
const apiSubscribeConfig = () => req.get("/config/subscribe");
// 老师主页：同城同名老师未来两周的课（含任教门店清单）
/**
 * 老师主页课表。
 * direction 默认是未来；`past` 取过去 N 天 —— 多数舞室只放最近几天的课，
 * 「未来两周」经常是空的，而库里保留了历史课，用「上周固定周几在哪上课」
 * 描述这位老师对用户更有用。
 */
const apiCoachTimeline = (name, cityId, days, direction) =>
  req.get("/coaches/timeline", {
    name,
    cityId,
    days: days || 14,
    ...(direction ? { direction } : {}),
  });
// 不想看的老师（本地即时生效，云端用于跨设备同步）
const apiBlocked = () => req.get("/blocked");
const apiBlock = (name) => req.post("/blocked", { name });
const apiUnblock = (name) => req.delete("/blocked/" + encodeURIComponent(name));
// 常看的老师（爱师）：与「不想看」是一对反向偏好，同样本地即时生效 + 云端同步
const apiFavCoaches = () => req.get("/coach-follows");
const apiFavCoach = (name) => req.post("/coach-follows", { name });
const apiUnfavCoach = (name) =>
  req.delete("/coach-follows/" + encodeURIComponent(name));
// 结构化逐条录入课表（用户手动补抓不到的店）
const apiImportSchedule = (payload) => req.post("/imports/schedule", payload);
// 我录过的课：录入是私有的，所以要能回看、能删
const apiMyImports = () => req.get("/imports/mine");
const apiDeleteImport = (id) => req.delete("/imports/schedule/" + id);
// 缺失舞室提报
const apiSubmitReport = (payload) => req.post("/reports", payload);
// 定位 → 城市：解析放在服务端（城市中心点表 + 「哪些城市真有课」都在库里）
const apiLocateCity = (lat, lng) => req.post("/cities/locate", { lat, lng });

module.exports = {
  ensureReady,
  apiLogin,
  apiCities,
  apiLocateCity,
  apiTimeline,
  apiMultiTimeline,
  apiBrands,
  apiStudios,
  apiStudioDetail,
  apiStudioTodaySchedules,
  apiStudioSchedules,
  apiScheduleDetail,
  apiScheduleVideoPreview,
  apiLiveBooking,
  apiStudioDayLive,
  apiFollows,
  apiFollow,
  apiUnfollow,
  apiCreateBooking,
  apiCancelBooking,
  apiBookings,
  apiPendingCount,
  apiReminders,
  apiAddReminder,
  apiRemoveReminder,
  apiSubscribeConfig,
  apiCoachTimeline,
  apiBlocked,
  apiBlock,
  apiUnblock,
  apiFavCoaches,
  apiFavCoach,
  apiUnfavCoach,
  apiSubmitReport,
  apiImportSchedule,
  apiMyImports,
  apiDeleteImport,
};