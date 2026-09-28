const app = getApp();
const api = require("../../services/api");
const { BOOKING_STATUS_LABEL, PLATFORM_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");
const { confirm } = require("../../utils/confirm");
const { getBlocked, unblock } = require("../../utils/blocked");
const { getFavCoaches, unfav } = require("../../utils/fav-coaches");
const { onNavTop } = require("../../utils/scroll-top");
const { onTapCoach } = require("../../utils/coach-nav");

Page({
  onNavTop,

  // 名单里的老师名可点 → 老师主页（没带 cityId，走当前城市兜底）
  goCoach: onTapCoach,

  data: {
    region: "CN",
    tab: "follows",
    follows: [],
    bookings: [],
    reminders: [],
    loading: false,
    blocked: [],
    favs: [],
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
    // 屏蔽/常看名单可能刚在老师页改过，每次进页面都重读一次本地
    this.loadBlocked();
    this.loadFavs();
    this.loadAll();
  },

  /**
   * 本机名单为准，云端那份只在有网时补进来。
   * 用户在这恢复显示后要立刻看到列表变化，等接口往返太慢。
   */
  loadBlocked() {
    const local = getBlocked();
    this.setData({ blocked: local });
    api.ensureReady()
      .then(() => api.apiBlocked())
      .then((remote) => {
        const merged = [...new Set(local.concat(remote || []))];
        this.setData({ blocked: merged });
      })
      .catch(() => {});
  },

  async unblockCoach(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    unblock(name);
    this.loadBlocked();
    try {
      await api.apiUnblock(name);
    } catch (err) {
      // 本地已经恢复显示了，云端同步失败不当成错误打断用户
      console.error("[dancehub] 取消屏蔽同步失败:", err);
    }
    toast(this, `已恢复「${name}」的课`, "success");
  },

  /** 常看的老师：与屏蔽名单同一套读法，本地优先、云端补并集 */
  loadFavs() {
    const local = getFavCoaches();
    this.setData({ favs: local });
    api
      .ensureReady()
      .then(() => api.apiFavCoaches())
      .then((remote) => {
        const merged = [...new Set(local.concat(remote || []))];
        this.setData({ favs: merged });
      })
      .catch(() => {});
  },

  async unfavCoach(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    unfav(name);
    this.loadFavs();
    try {
      await api.apiUnfavCoach(name);
    } catch (err) {
      console.error("[dancehub] 取消常看同步失败:", err);
    }
    toast(this, `已把「${name}」移出常看`, "success");
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
          // 品牌名里带 emoji 的话 charAt(0) 会拿到半个字符，先剥掉
          initial: String(f.studio.name || "?")
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
            .trim()
            .charAt(0) || "?",
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

  goAbout() {
    wx.navigateTo({ url: "/pages/about/about" });
  },

  /** 课表录入：抓取覆盖不到的门店，让用户自己补一节 */
  goImport() {
    wx.navigateTo({ url: "/pages/import/import" });
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

  async cancelBooking(e) {
    const scheduleId = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || "这节课";
    const yes = await confirm({
      title: "取消预约",
      content: `确定取消「${name}」的预约吗？`,
      confirmText: "取消预约",
    });
    if (!yes) return;
    try {
      const res = await api.apiCancelBooking(scheduleId);
      toast(
        this,
        res && res.reminderRemoved ? "已取消预约，开课提醒也关掉了" : "已取消预约",
        "success",
      );
      this.loadAll();
      // 待确认徽标是按未确认预约数算的，取消后要立刻重算
      if (typeof this.getTabBar === "function" && this.getTabBar()) {
        this.getTabBar().refreshBadge();
      }
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