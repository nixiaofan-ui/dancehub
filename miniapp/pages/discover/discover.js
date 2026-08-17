const app = getApp();
const api = require("../../services/api");
const jump = require("../../services/jump");
const {
  PLATFORM_LABEL,
  DIFF_LABEL,
  BOOKING_STATUS_LABEL,
} = require("../../utils/constants");
const { requestSubscribe } = require("../../utils/subscribe");

Page({
  data: {
    region: "CN",
    cities: [],
    cityId: null,
    keyword: "",
    studios: [],
    followedIds: [],
    loading: false,

    expandedId: null,
    panel: { visible: false, item: null },
  },

  async onLoad() {
    const g = app.globalData;
    this.setData({ region: g.region, cityId: g.cityId, cities: g.cities });
    this.load();
  },

  async onShow() {
    const g = app.globalData;
    if (this.data.region !== g.region || this.data.cityId !== g.cityId) {
      this.setData({ region: g.region, cityId: g.cityId, cities: g.cities });
      this.load();
    }
  },

  async load() {
    if (!this.data.cityId) return;
    await api.ensureReady();
    this.setData({ loading: true });
    try {
      const params = { cityId: this.data.cityId };
      if (this.data.keyword) params.keyword = this.data.keyword;
      const [rawStudios, follows] = await Promise.all([
        api.apiStudios(params),
        api.apiFollows(),
      ]);
      const followedIds = follows.map((f) => f.studio.id);
      const studios = rawStudios.map((s) => ({
        ...s,
        followed: followedIds.includes(s.id),
        platformLabel: PLATFORM_LABEL[s.platform] || s.platform,
        initial: (s.name || "?").charAt(0),
        expanded: false,
        schedules: [],
        schedulesLoading: false,
      }));
      this.setData({
        studios,
        followedIds,
        loading: false,
        expandedId: null,
        panel: { visible: false, item: null },
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  switchRegion(e) {
    const region = e.currentTarget.dataset.r;
    if (region === this.data.region) return;
    const city = app.globalData.cities.find((c) => c.region === region);
    app.globalData.region = region;
    app.globalData.cityId = city ? city.id : null;
    this.setData({ region, cityId: city ? city.id : null });
    this.load();
  },

  selectCity(e) {
    const cityId = e.currentTarget.dataset.id;
    if (cityId === this.data.cityId) return;
    app.globalData.cityId = cityId;
    this.setData({ cityId });
    this.load();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearchConfirm() {
    this.load();
  },

  clearKeyword() {
    this.setData({ keyword: "" });
    this.load();
  },

  toggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.expandedId === id) {
      const studios = this.data.studios.map((s) =>
        s.id === id ? { ...s, expanded: false } : s,
      );
      this.setData({ studios, expandedId: null });
      return;
    }
    const studios = this.data.studios.map((s) => ({
      ...s,
      expanded: s.id === id,
    }));
    this.setData({ studios, expandedId: id });
    this.loadTodaySchedules(id);
  },

  async loadTodaySchedules(id) {
    const studios = this.data.studios.map((s) =>
      s.id === id ? { ...s, schedulesLoading: true, schedules: [] } : s,
    );
    this.setData({ studios });
    try {
      const res = await api.apiStudioTodaySchedules(id);
      const studio = this.data.studios.find((s) => s.id === id);
      const schedules = (res.items || []).map((item) => ({
        ...item,
        diffLabel: DIFF_LABEL[item.difficulty] || item.difficulty,
        coachName: item.coach ? item.coach.name : "待定",
        statusLabel: BOOKING_STATUS_LABEL[item.bookingStatus] || "可约",
        statusClass:
          item.bookingStatus === "CONFIRMED"
            ? "ok"
            : item.bookingStatus === "PENDING"
              ? "pending"
              : "none",
        studio: { id: studio.id, name: studio.name, platform: studio.platform },
      }));
      const next = this.data.studios.map((s) =>
        s.id === id ? { ...s, schedules, schedulesLoading: false } : s,
      );
      this.setData({ studios: next });
    } catch (err) {
      const next = this.data.studios.map((s) =>
        s.id === id ? { ...s, schedulesLoading: false } : s,
      );
      this.setData({ studios: next });
      wx.showToast({ title: err.message, icon: "none" });
    }
  },

  openSchedulePanel(e) {
    const id = e.currentTarget.dataset.id;
    const studio = this.data.studios.find((s) => s.id === this.data.expandedId);
    if (!studio) return;
    const item = studio.schedules.find((x) => x.id === id);
    if (!item) return;
    this.setData({ panel: { visible: true, item } });
  },

  closePanel() {
    this.setData({ panel: { visible: false, item: null } });
  },

  async goBook() {
    const item = this.data.panel.item;
    if (!item) return;
    try {
      await api.apiCreateBooking(item.id, "JUMP");
      jump.jumpToPlatform(item.studio, item);
      this.setData({ panel: { visible: false, item: null } });
      if (this.data.expandedId) this.loadTodaySchedules(this.data.expandedId);
    } catch (e) {
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  async markBooked() {
    const item = this.data.panel.item;
    if (!item) return;
    try {
      await api.apiCreateBooking(item.id, "MANUAL");
      this.setData({ panel: { visible: false, item: null } });
      wx.showToast({ title: "已标记预约", icon: "success" });
      if (this.data.expandedId) this.loadTodaySchedules(this.data.expandedId);
    } catch (e) {
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  async toggleRemind() {
    const item = this.data.panel.item;
    if (!item) return;
    try {
      if (item.reminded) {
        await api.apiRemoveReminder(item.id);
        wx.showToast({ title: "已关闭提醒", icon: "none" });
      } else {
        const tplId = app.globalData.classReminderTplId;
        const granted = tplId ? await requestSubscribe(tplId) : false;
        await api.apiAddReminder(item.id, granted);
        wx.showToast({
          title: granted ? "已开启订阅提醒" : "已开启本地提醒",
          icon: "none",
        });
      }
      item.reminded = !item.reminded;
      this.setData({ panel: { visible: true, item } });
      if (this.data.expandedId) this.loadTodaySchedules(this.data.expandedId);
    } catch (e) {
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  async toggleFollow(e) {
    const id = e.currentTarget.dataset.id;
    const isFollowed = this.data.followedIds.includes(id);
    try {
      if (isFollowed) {
        await api.apiUnfollow(id);
      } else {
        await api.apiFollow(id);
      }
      const followedIds = isFollowed
        ? this.data.followedIds.filter((x) => x !== id)
        : this.data.followedIds.concat(id);
      const studios = this.data.studios.map((s) =>
        s.id === id ? { ...s, followed: !isFollowed } : s,
      );
      this.setData({ followedIds, studios });
      wx.showToast({ title: isFollowed ? "已取消关注" : "已关注", icon: "none" });
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  },
});
