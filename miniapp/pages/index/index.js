const app = getApp();
const api = require("../../services/api");
const jump = require("../../services/jump");
const { dateKey, addDays, todayKey, formatChip } = require("../../utils/date");
const { DIFF_LABEL } = require("../../utils/constants");
const { requestSubscribe } = require("../../utils/subscribe");
const { toast } = require("../../utils/toast");

Page({
  data: {
    region: "CN",
    cities: [],
    cityId: null,

    dates: [],
    swiperCurrent: 1,
    currentKey: "",

    items: [],
    pendingCount: 0,
    loading: false,

    panel: { visible: false, item: null },
  },

  async onLoad() {
    this.currentDate = new Date();
    const g = app.globalData;
    this.setData({
      region: g.region,
      cityId: g.cityId,
      cities: g.cities,
    });
    this.rebuildDates(this.currentDate);
    this.load();
  },

  async onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      const tb = this.getTabBar();
      tb.setData({ selected: 0 });
      tb.refreshBadge();
    }
    const g = app.globalData;
    if (this.data.region !== g.region || this.data.cityId !== g.cityId) {
      this.setData({ region: g.region, cityId: g.cityId, cities: g.cities });
      this.load();
    }
  },

  rebuildDates(center) {
    const dates = [-1, 0, 1].map((n) => formatChip(addDays(center, n)));
    this.setData({ dates, swiperCurrent: 1, currentKey: dateKey(center) });
  },

  async load() {
    if (!this.data.cityId) return;
    await api.ensureReady();
    this.setData({ loading: true });
    const key = dateKey(this.currentDate);
    try {
      const res = await api.apiTimeline(this.data.cityId, key);
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const isToday = key === todayKey();

      const items = (res.items || []).map((item) => {
        const [h, m] = item.startTime.split(":").map(Number);
        const isPast = isToday && h * 60 + m < nowMin;
        let slotClass = "";
        let slotText = "";
        if (item.bookingStatus === "CONFIRMED") {
          slotClass = "ok";
          slotText = "✅ 已约";
        } else if (item.bookingStatus === "PENDING") {
          slotClass = "warn";
          slotText = "待确认";
        } else {
          const rm = item.remark || "";
          if (rm.indexOf("满") >= 0) {
            slotClass = "full";
            slotText = "已截止";
          } else if (rm.indexOf("预约中") >= 0) {
            slotClass = "ok";
            slotText = "余位充足";
          }
        }
        return {
          ...item,
          isPast,
          diffLabel: DIFF_LABEL[item.difficulty] || item.difficulty,
          coachName: item.coach ? item.coach.name : "待定",
          edgeClass: "edge-" + (item.difficulty || "ALL_LEVELS").toLowerCase(),
          slotClass,
          slotText,
        };
      });
      const pendingCount = items.filter((i) => i.bookingStatus === "PENDING").length;
      this.setData({ items, pendingCount, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      toast(this, e.message);
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

  prevDay() {
    this.moveDay(-1);
  },
  nextDay() {
    this.moveDay(1);
  },

  moveDay(dir) {
    this.currentDate = addDays(this.currentDate, dir);
    this.rebuildDates(this.currentDate);
    this.load();
  },

  onSwiperChange(e) {
    const cur = e.detail.current;
    const dir = cur === 0 ? -1 : cur === 2 ? 1 : 0;
    if (!dir) return;
    this.moveDay(dir);
  },

  onTapDate(e) {
    const key = e.currentTarget.dataset.key;
    const idx = this.data.dates.findIndex((d) => d.key === key);
    if (idx === 0) this.moveDay(-1);
    else if (idx === 2) this.moveDay(1);
  },

  openPanel(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.items.find((i) => i.id === id);
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
      this.refreshBadge();
      this.load();
    } catch (e) {
      toast(this, e.message);
    }
  },

  async markBooked() {
    const item = this.data.panel.item;
    if (!item) return;
    try {
      await api.apiCreateBooking(item.id, "MANUAL");
      this.setData({ panel: { visible: false, item: null } });
      this.refreshBadge();
      toast(this, "已标记预约", "success");
      this.load();
    } catch (e) {
      toast(this, e.message);
    }
  },

  async toggleRemind() {
    const item = this.data.panel.item;
    if (!item) return;
    try {
      if (item.reminded) {
        await api.apiRemoveReminder(item.id);
        toast(this, "已关闭提醒");
      } else {
        // 请求订阅消息授权（一次性）
        const tplId = app.globalData.classReminderTplId;
        const granted = tplId ? await requestSubscribe(tplId) : false;
        await api.apiAddReminder(item.id, granted);
        toast(this, granted ? "已开启订阅提醒" : "已开启本地提醒");
      }
      item.reminded = !item.reminded;
      this.setData({ panel: { visible: true, item } });
      this.load();
    } catch (e) {
      toast(this, e.message);
    }
  },

  goConfirm() {
    const pending = this.data.items.find((i) => i.bookingStatus === "PENDING");
    if (pending) this.setData({ panel: { visible: true, item: pending } });
  },

  refreshBadge() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().refreshBadge();
    }
  },

  goDiscover() {
    wx.switchTab({ url: "/pages/discover/discover" });
  },

  goProfile() {
    wx.switchTab({ url: "/pages/profile/profile" });
  },
});