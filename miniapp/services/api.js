const req = require("../utils/request");

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
          const data = await req.post("/auth/login", { code: r.code });
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

const apiFollows = () => req.get("/follows");
const apiFollow = (studioId) => req.post("/follows", { studioId });
const apiUnfollow = (studioId) => req.delete("/follows/" + studioId);

const apiCreateBooking = (scheduleId, method) => req.post("/bookings", { scheduleId, method });
const apiBookings = () => req.get("/bookings");

const apiReminders = () => req.get("/reminders");
const apiAddReminder = (scheduleId) => req.post("/reminders", { scheduleId });
const apiRemoveReminder = (scheduleId) => req.delete("/reminders/" + scheduleId);

module.exports = {
  ensureReady,
  apiLogin,
  apiCities,
  apiTimeline,
  apiStudios,
  apiFollows,
  apiFollow,
  apiUnfollow,
  apiCreateBooking,
  apiBookings,
  apiReminders,
  apiAddReminder,
  apiRemoveReminder,
};