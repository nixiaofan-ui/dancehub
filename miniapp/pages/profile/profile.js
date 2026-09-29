const app = getApp();
const api = require("../../services/api");
const { BOOKING_STATUS_LABEL, PLATFORM_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");
const { confirm } = require("../../utils/confirm");
const { getBlocked, unblock, block } = require("../../utils/blocked");
const { getFavCoaches, unfav, fav } = require("../../utils/fav-coaches");
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
    // 上面两份名单合成的一张老师表：{name, fav, blocked}
    coaches: [],
    // 我录过课的城市（含库外新建的）
    myCities: [],
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
    this.loadMyCities();
  },

  /**
   * 「我的城市」：我录过课的城市，按课数倒序。
   *
   * 存在的理由：录入经常发生在**我们还没接入的城市**（用户人在三亚，库里只有北上广）。
   * 这类城市在切换城市时压根没有选项，录完就找不回去了 ——
   * 课在库里，人却看不到。这里给它们一个固定入口。
   */
  async loadMyCities() {
    try {
      await api.ensureReady();
      const rows = (await api.apiMyCities()) || [];
      this.setData({ myCities: rows });
    } catch (e) {
      // 没有录入记录时就是空列表，不该弹错打断「我的」页
      this.setData({ myCities: [] });
    }
  },

  /**
   * 点「我的城市」→ 切到那座城看课表。
   * 用 manual 源：这是用户明确选的，不该被预约城市/定位再拽走。
   */
  goMyCity(e) {
    const { id, region, name } = e.currentTarget.dataset;
    if (!id) return;
    app.setCity(region || "CN", Number(id), "manual");
    wx.showToast({ title: "已切到" + name, icon: "none" });
    wx.switchTab({ url: "/pages/discover/discover" });
  },

  /**
   * 本机名单为准，云端那份只在有网时补进来。
   * 用户在这恢复显示后要立刻看到列表变化，等接口往返太慢。
   */
  /**
   * 「常看」和「不看」是同一件事的两端：一个让他的课往前排，一个把他的课收起来。
   * 所以名单合在一处读、合在一处展示 —— 拆成两个 tab 反而互相看不见，
   * 改个偏好还得先想清楚要去哪一栏。
   */
  loadBlocked() {
    const local = getBlocked();
    this.setData({ blocked: local }, () => this.buildCoaches());
    api.ensureReady()
      .then(() => api.apiBlocked())
      .then((remote) => {
        const merged = [...new Set(local.concat(remote || []))];
        this.setData({ blocked: merged }, () => this.buildCoaches());
      })
      .catch(() => {});
  },

  /** 常看的老师：与屏蔽名单同一套读法，本地优先、云端补并集 */
  loadFavs() {
    const local = getFavCoaches();
    this.setData({ favs: local }, () => this.buildCoaches());
    api
      .ensureReady()
      .then(() => api.apiFavCoaches())
      .then((remote) => {
        const merged = [...new Set(local.concat(remote || []))];
        this.setData({ favs: merged }, () => this.buildCoaches());
      })
      .catch(() => {});
  },

  /**
   * 把两份名单合成一个老师列表，每人一行带两个开关。
   * 排序：常看的在前、被屏蔽的在后（同档保持名单本身顺序），
   * 这样一眼扫下来先看的是自己真正在追的人。
   */
  buildCoaches() {
    const favs = this.data.favs || [];
    const blocked = this.data.blocked || [];
    const names = [...new Set(favs.concat(blocked))];
    const rows = names.map((name) => ({
      name,
      fav: favs.indexOf(name) >= 0,
      blocked: blocked.indexOf(name) >= 0,
    }));
    const weight = (r) => (r.fav ? 2 : 0) + (r.blocked ? 1 : 0);
    rows.sort((a, b) => weight(b) - weight(a));
    this.setData({ coaches: rows });
  },

  /** 改完本地名单后重读一次再重建列表：工具函数是权威，别在 data 上自己加减 */
  syncCoachLists() {
    this.setData(
      { blocked: getBlocked(), favs: getFavCoaches() },
      () => this.buildCoaches(),
    );
  },

  /**
   * 切「常看」。常看和「不看」不能同时成立 —— 一个要往前排、一个要藏起来，
   * 同时开着等于没设，所以开一个会自动解另一个（课表的实际表现也确实如此：
   * foldBlocked 优先于 fav 置顶）。
   */
  async toggleCoachFav(e) {
    const name = e.currentTarget.dataset.name;
    const row = (this.data.coaches || []).find((r) => r.name === name);
    if (!row) return;
    const next = !row.fav;
    if (next) {
      fav(name);
      if (row.blocked) unblock(name);
    } else {
      unfav(name);
    }
    this.syncCoachLists();
    try {
      if (next) {
        await api.apiFavCoach(name);
        if (row.blocked) await api.apiUnblock(name);
      } else {
        await api.apiUnfavCoach(name);
      }
    } catch (err) {
      console.error("[dancehub] 常看同步失败:", err);
    }
    toast(this, next ? `已把「${name}」设为常看` : `已把「${name}」移出常看`, "success");
  },

  /** 切「不看」，同样与常看互斥 */
  async toggleCoachBlock(e) {
    const name = e.currentTarget.dataset.name;
    const row = (this.data.coaches || []).find((r) => r.name === name);
    if (!row) return;
    const next = !row.blocked;
    if (next) {
      block(name);
      if (row.fav) unfav(name);
    } else {
      unblock(name);
    }
    this.syncCoachLists();
    try {
      if (next) {
        await api.apiBlock(name);
        if (row.fav) await api.apiUnfavCoach(name);
      } else {
        await api.apiUnblock(name);
      }
    } catch (err) {
      console.error("[dancehub] 屏蔽同步失败:", err);
    }
    toast(this, next ? `不再显示「${name}」的课` : `已恢复「${name}」的课`, "success");
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