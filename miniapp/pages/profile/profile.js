const app = getApp();
const api = require("../../services/api");
const { BOOKING_STATUS_LABEL, PLATFORM_LABEL } = require("../../utils/constants");

Page({
  data: {
    region: "CN",
    tab: "follows",
    follows: [],
    bookings: [],
    reminders: [],
    loading: false,
  },

  async onLoad() {
    this.setData({ region: app.globalData.region });
    this.loadAll();
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      const tb = this.getTabBar();
      tb.setData({ selected: 3 });
      tb.refreshBadge();
    }
    if (this.data.region !== app.globalData.region) {
      this.setData({ region: app.globalData.region });
    }
    this.loadAll();
  },

  async loadAll() {
    await api.ensureReady();
    this.setData({ loading: true });
    try {
      const [follows, bookings, reminders] = await Promise.all([
        api.apiFollows(),
        api.apiBookings(),
        api.apiReminders(),
      ]);
      this.setData({
        follows: follows.map((f) => ({
          ...f,
          platformLabel: PLATFORM_LABEL[f.studio.platform] || f.studio.platform,
          initial: (f.studio.name || "?").charAt(0),
        })),
        bookings: bookings.map((b) => ({
          ...b,
          statusLabel: BOOKING_STATUS_LABEL[b.status] || b.status,
          dateLabel: (b.schedule.scheduleDate + "").slice(0, 10),
        })),
        reminders: reminders.map((r) => ({
          ...r,
          dateLabel: (r.schedule.scheduleDate + "").slice(0, 10),
        })),
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  switchRegion(e) {
    const region = e.currentTarget.dataset.r;
    if (region === this.data.region) return;
    const city = app.globalData.cities.find((c) => c.region === region);
    app.globalData.region = region;
    app.globalData.cityId = city ? city.id : null;
    this.setData({ region });
  },

  async unfollow(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await api.apiUnfollow(id);
      wx.showToast({ title: "已取消关注", icon: "none" });
      this.loadAll();
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  },

  async closeReminder(e) {
    const scheduleId = e.currentTarget.dataset.id;
    try {
      await api.apiRemoveReminder(scheduleId);
      wx.showToast({ title: "已关闭提醒", icon: "none" });
      this.loadAll();
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  },

  goDiscover() {
    wx.switchTab({ url: "/pages/discover/discover" });
  },
});