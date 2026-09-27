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
const apiStudios = (params) => req.get("/studios", params || {});
const apiStudioDetail = (id) => req.get(`/studios/${id}`);
const apiStudioTodaySchedules = (studioId) =>
  req.get(`/studios/${studioId}/today-schedules`);
const apiStudioSchedules = (studioId, from, to) =>
  req.get("/schedules", { studioId, from, to });
const apiScheduleDetail = (id) => req.get(`/schedules/${id}`);
const apiScheduleVideoPreview = (id) => req.get(`/schedules/${id}/video-preview`);

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
const apiSubscribeConfig = () => req.get("/config/subscribe");
// 定位 → 城市：解析放在服务端（城市中心点表 + 「哪些城市真有课」都在库里）
const apiLocateCity = (lat, lng) => req.post("/cities/locate", { lat, lng });

module.exports = {
  ensureReady,
  apiLogin,
  apiCities,
  apiLocateCity,
  apiTimeline,
  apiStudios,
  apiStudioDetail,
  apiStudioTodaySchedules,
  apiStudioSchedules,
  apiScheduleDetail,
  apiScheduleVideoPreview,
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
};