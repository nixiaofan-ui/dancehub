const app = getApp();
const api = require("../../services/api");
const { BOOKING_STATUS_LABEL, PLATFORM_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");

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
      tb.setData({ selected: 2 });
      tb.refreshBadge();
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
          cityName: b.schedule.city || "",
        })),
        reminders: reminders.map((r) => ({
          ...r,
          dateLabel: (r.schedule.scheduleDate + "").slice(0, 10),
          cityName: r.schedule.city || "",
        })),
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      toast(this, e.message);
    }
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  async unfollow(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await api.apiUnfollow(id);
      toast(this, "已取消关注", "success");
      this.loadAll();
    } catch (err) {
      toast(this, err.message);
    }
  },

  async closeReminder(e) {
    const scheduleId = e.currentTarget.dataset.id;
    try {
      await api.apiRemoveReminder(scheduleId);
      toast(this, "已关闭提醒");
      this.loadAll();
    } catch (err) {
      toast(this, err.message);
    }
  },

  goDiscover() {
    wx.switchTab({ url: "/pages/discover/discover" });
  },
});