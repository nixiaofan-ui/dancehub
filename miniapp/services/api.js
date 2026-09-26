const req = require("../utils/request");

async function ensureReady() {
  const app = getApp();
  if (app.globalData.token) return;
  if (app.ready) await app.ready;
}

/**
 * 本机调试用的设备标识：只在服务端没配 appid/secret（走 dev 降级登录）时有意义。
 * 必须持久化 —— 否则每次登录都会生成一个新账号，关注列表会凭空消失。
 * 配好 WECHAT_APPID/WECHAT_SECRET 后这段逻辑完全不参与。
 */
function devDeviceId() {
  try {
    let id = wx.getStorageSync("devDeviceId");
    if (!id) {
      id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      wx.setStorageSync("devDeviceId", id);
    }
    return id;
  } catch (e) {
    return "";
  }
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
  apiBookings,
  apiPendingCount,
  apiReminders,
  apiAddReminder,
  apiRemoveReminder,
  apiSubscribeConfig,
};