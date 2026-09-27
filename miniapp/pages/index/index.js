const app = getApp();
const api = require("../../services/api");
const jump = require("../../services/jump");
const { dateKey, addDays, todayKey, formatChip } = require("../../utils/date");
const { DIFF_LABEL } = require("../../utils/constants");
const { API_HOST } = require("../../utils/config");
const { requestSubscribe } = require("../../utils/subscribe");
const { toast } = require("../../utils/toast");
const { confirm } = require("../../utils/confirm");
const { bookCourse } = require("../../utils/booking");

Page({
  data: {
    region: "CN",
    cities: [],
    filteredCities: [],
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
    // 全局「预约/关注/提醒」写操作计数，用来判断课表数据是否被弄脏
    this.seenDirty = app.globalData.dirty || 0;
    const g = app.globalData;
    const cities = g.cities || [];
    const filteredCities = cities.filter((c) => c.region === g.region);
    this.setData({
      region: g.region,
      cityId: g.cityId,
      cities: cities,
      filteredCities: filteredCities,
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
      // 用户在别处（或本页）手动选了城市，以他选的为准
      this.cityFollowOff = true;
      const cities = g.cities || [];
      const filteredCities = cities.filter((c) => c.region === g.region);
      this.setData({ region: g.region, cityId: g.cityId, cities: cities, filteredCities: filteredCities });
      this.load();
      return;
    }
    const dirty = g.dirty || 0;
    const needFollow = !this.cityChecked || dirty !== this.seenDirty;
    this.cityChecked = true;
    this.seenDirty = dirty;

    // 刚约完课 / 首次进课表：先看一眼该停在哪个城市，再决定刷不刷
    if (needFollow) {
      const moved = await this.followBookedCity();
      if (moved) return; // 内部已经 load 过了
      this.load({ silent: true });
      return;
    }
    // tabBar 页面切走不会被销毁，onLoad 只跑一次。在课程详情或「我的」里
    // 预约/取消之后回到课表，必须自己刷一次，否则「✅ 已约」还停留在上一次
    // 请求时的状态。静默刷新（不切骨架屏），并做一点节流，避免频繁切 tab
    // 把列表刷得来回闪。
    const stale = Date.now() - (this.lastLoadedAt || 0) > 1500;
    if (stale) this.load({ silent: true });
  },

  /**
   * 把课表停在「有预约的那座城市」。
   *
   * 预约往往是在发现页/搜索里跨城市发生的 —— 回到课表时当前城市可能根本不是
   * 你约了课的地方，列表里一节都看不到，只能自己想起来去切城市。
   * 这里查一次 /bookings：当前城市一节预约都没有、别处有时，切过去并说明原因。
   *
   * 三条约束：
   *   1) 只统计今天及以后的预约（上过的课不该把城市拽回去）
   *   2) 当前城市本来就有预约时不动，避免跟用户抢方向盘
   *   3) 用户手动切过城市后（cityFollowOff）本次会话不再自动跟
   *
   * @returns 切了城市返回 true（调用方别再重复 load）
   */
  async followBookedCity() {
    if (this.cityFollowOff) return false;
    let list;
    try {
      list = await api.apiBookings();
    } catch (e) {
      return false; // 没登录或接口挂了：照常显示当前城市，不打扰
    }
    if (!Array.isArray(list) || !list.length) return false;

    const today = todayKey();
    const counts = new Map();
    for (const b of list) {
      const s = b.schedule || {};
      const day = String(s.scheduleDate || "").slice(0, 10);
      if (day < today) continue;
      const name = s.city;
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    if (!counts.size) return false;

    const cities = app.globalData.cities || [];
    const cur = cities.find((c) => c.id === this.data.cityId);
    if (cur && counts.has(cur.name)) return false;

    // 多座城市都有预约时，取课最多的那座
    const [name, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const city =
      cities.find((c) => c.name === name && c.region === this.data.region) ||
      cities.find((c) => c.name === name);
    if (!city || city.id === this.data.cityId) return false;

    app.setCity(city.region, city.id);
    this.setData({
      region: city.region,
      cityId: city.id,
      cities: cities,
      filteredCities: cities.filter((c) => c.region === city.region),
    });
    toast(this, `已切到${city.name}：你有 ${n} 节预约`);
    await this.load();
    return true;
  },

  // 下拉刷新：用户主动下拉时不再静默，显示骨架屏 + 出错要提示
  async onPullDownRefresh() {
    if (!this.data.cityId) {
      wx.stopPullDownRefresh();
      toast(this, "请先选择城市");
      return;
    }
    await this.load();
    this.seenDirty = app.globalData.dirty || 0;
    wx.stopPullDownRefresh();
  },

  rebuildDates(center) {
    const dates = [-1, 0, 1].map((n) => formatChip(addDays(center, n)));
    this.setData({ dates, swiperCurrent: 1, currentKey: dateKey(center) });
  },

  async load(opts) {
    const silent = !!(opts && opts.silent);
    if (!this.data.cityId) return;
    await api.ensureReady();
    // 静默刷新（onShow 触发）不动 loading，否则每次切回 tab 都闪一下骨架屏
    if (!silent) this.setData({ loading: true });
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
      this.lastLoadedAt = Date.now();
      this.seenDirty = app.globalData.dirty || 0;
    } catch (e) {
      this.setData({ loading: false });
      this.lastLoadedAt = Date.now();
      // 后台静默刷新失败就不弹提示了：用户没主动操作，不该被报错打断
      if (!silent) toast(this, e.message);
    }
  },

  switchRegion(e) {
    const region = e.currentTarget.dataset.r;
    if (region === this.data.region) return;
    const cities = app.globalData.cities || [];
    const filteredCities = cities.filter((c) => c.region === region);
    // 该地区一个城市都没有时给提示，否则只是静默切过去显示空白。
    // ⚠ 两种情况要分开：城市列表整个为空，说明 /api/cities 就没拉到
    // （服务端没起 / 连不上），这跟「海外没开放」完全是两回事，
    // 混为一谈会把真实故障掩盖掉。
    if (!filteredCities.length) {
      wx.showToast({
        title: !cities.length
          ? "连不上 " + API_HOST
          : region === "OVERSEAS"
            ? "海外场馆暂未开放"
            : "暂无可选城市",
        icon: "none",
      });
      return;
    }
    const city = filteredCities[0];
    app.setCity(region, city.id);
    this.cityFollowOff = true; // 自己选的城市，别再被预约拽走
    this.setData({ region, cityId: city.id, cities, filteredCities });
    this.load();
  },

  selectCity(e) {
    const cityId = e.currentTarget.dataset.id;
    if (cityId === this.data.cityId) return;
    app.setCity(this.data.region, cityId);
    this.cityFollowOff = true; // 同上
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
      // 撞课且用户放弃时返回 null：面板保持打开，也不跳转
      const res = await bookCourse(item.id, "JUMP", item);
      if (!res) return;
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
      const res = await bookCourse(item.id, "MANUAL", item);
      if (!res) return;
      this.setData({ panel: { visible: false, item: null } });
      this.refreshBadge();
      toast(this, "已标记预约", "success");
      this.load();
    } catch (e) {
      toast(this, e.message);
    }
  },

  async cancelBooking() {
    const item = this.data.panel.item;
    if (!item) return;
    const yes = await confirm({
      title: "取消预约",
      content: `确定取消「${item.courseName || "这节课"}」的预约吗？`,
      confirmText: "取消预约",
    });
    if (!yes) return;
    try {
      const res = await api.apiCancelBooking(item.id);
      this.setData({ panel: { visible: false, item: null } });
      this.refreshBadge();
      toast(
        this,
        res && res.reminderRemoved ? "已取消预约，开课提醒也关掉了" : "已取消预约",
        "success",
      );
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
        toast(
          this,
          granted
            ? "已开启订阅提醒"
            : tplId
              ? "仅本地提醒（未授权推送）"
              : "仅本地提醒（订阅模板未配置）",
        );
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