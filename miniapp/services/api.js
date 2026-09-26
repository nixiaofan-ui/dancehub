const req = require("../utils/request");
const { devDeviceId } = require("../utils/device");

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
const apiFollow = (studioId) => req.post("/follows", { studioId });
const apiUnfollow = (studioId) => req.delete("/follows/" + studioId);

const apiCreateBooking = (scheduleId, method) => req.post("/bookings", { scheduleId, method });
// 取消预约：服务端会连同一并返回 hasReminder，用来提示用户提醒是否还开着
const apiCancelBooking = (scheduleId) => req.delete("/bookings/" + scheduleId);
const apiBookings = () => req.get("/bookings");
const apiPendingCount = () => req.get("/bookings/pending-count");

const apiReminders = () => req.get("/reminders");
const apiAddReminder = (scheduleId, subscribe) =>
  req.post("/reminders", { scheduleId, subscribe: Boolean(subscribe) });
const apiRemoveReminder = (scheduleId) => req.delete("/reminders/" + scheduleId);
const apiSubscribeConfig = () => req.get("/config/subscribe");

module.exports = {
  ensureReady,
  apiLogin,
  apiCities,
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