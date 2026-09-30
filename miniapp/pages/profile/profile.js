const app = getApp();
const api = require("../../services/api");
const { BOOKING_STATUS_LABEL, PLATFORM_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");
const { confirm, choose } = require("../../utils/confirm");
const { getBlocked, unblock, block } = require("../../utils/blocked");
const { getFavCoaches, unfav, fav } = require("../../utils/fav-coaches");
const { onNavTop } = require("../../utils/scroll-top");
const { onTapCoach } = require("../../utils/coach-nav");
const { bookCourse } = require("../../utils/booking");
const { todayKey, parseKey, WEEK } = require("../../utils/date");
// 舞种本身是服务端按未来课表算好、随关注接口下发的，前端不重新识别
// （课表没拉下来时前端也识别不出）。
const { OTHER, buildStyleChips, filterByStyle } = require("../../utils/style-filter");

Page({
  onNavTop,

  // 名单里的老师名可点 → 老师主页（没带 cityId，走当前城市兜底）
  goCoach: onTapCoach,

  data: {
    region: "CN",
    tab: "follows",
    // follows = 全部关注（舞种条计数用），followsView = 当前筛选后要渲染的
    follows: [],
    followsView: [],
    // 舞种筛选条（关注列表按「这家店有没有这个舞种」筛）
    styleChips: [],
    showStyleBar: false,
    styleAllOn: true,
    bookings: [],
    reminders: [],
    // 「我的课表」：我录的课（/imports/mine）和我约的课（/bookings）合并去重后的结果。
    //
    // 以前这两个来源分属两个列表：预约记录里查不到我录的课，而录课页面藏在
    // 「我的」的一条小字后面 —— 于是用户录完就找不到了，只能靠记。
    // 它们本来就是同一样东西：「跟我有关的课」。
    schedules: [],
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
      const [follows, bookings, reminders, mine] = await Promise.all([
        api.apiFollows(),
        api.apiBookings(),
        api.apiReminders(),
        api.apiMyImports(),
      ]);
      const bookingRows = bookings.map((b) => ({
        ...b,
        statusLabel: BOOKING_STATUS_LABEL[b.status] || b.status,
        dateLabel: (b.schedule.scheduleDate + "").slice(0, 10),
        cityName: b.schedule.city || "",
      }));
      const followRows = follows.map((f) => ({
        ...f,
        platformLabel: PLATFORM_LABEL[f.studio.platform] || f.studio.platform,
        // 品牌名里带 emoji 的话 charAt(0) 会拿到半个字符，先剥掉
        initial:
          String(f.studio.name || "?")
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
            .trim()
            .charAt(0) || "?",
        // 卡片上最多平铺 3 个舞种，多了反而看不出重点
        styleText: (f.studio.styles || []).slice(0, 3).join(" · "),
      }));
      this.allFollows = followRows;
      this.syncFollowStyleChips(followRows);
      this.setData({
        follows: followRows,
        followsView: this.filterFollowsByStyle(followRows),
        bookings: bookingRows,
        schedules: buildMySchedule(bookingRows, mine || []),
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

  /** 关注列表点卡片 → 该店课表（和发现页点门店同一入口，别做成两个详情页） */
  openStudio(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: "/pages/studio/weekly?id=" + id });
  },

  // ── 关注列表的舞种筛选 ──────────────────────────────
  // 这里筛的是**店**：一家店既教 Jazz 又教 Kpop，选任一都该留下它。
  // 所以一家店要往它每个舞种各自的计数里投一票 —— 和首页「按课筛」的算法不同，
  // 那边的单位是一节课，这边是一家店。

  /** 取一家店的舞种标签；没有未来排课（或课名认不出）的归「其它」 */
  stylesOf(item) {
    const list = (item.studio && item.studio.styles) || [];
    return list.length ? list : [OTHER];
  },

  /**
   * ⚠ 计数用**未经过筛**的全量（allFollows），不跟着当前勾选变：
   * 否则每点一下 chip，条上的数字就跟着跳，看起来像筛选条自己坏了。
   */
  syncFollowStyleChips(rows) {
    const r = buildStyleChips(rows, (x) => this.stylesOf(x), this.activeStyles, this._styleLabels);
    this.activeStyles = r.active;
    this._styleLabels = r.labels;
    this.setData({
      styleChips: r.chips,
      showStyleBar: r.show,
      styleAllOn: r.active.length === r.chips.length,
    });
  },

  filterFollowsByStyle(rows) {
    return filterByStyle(rows, (x) => this.stylesOf(x), this.activeStyles);
  },

  tapStyleChip(e) {
    const label = e.currentTarget.dataset.label;
    const active = new Set(this.activeStyles || []);
    if (active.has(label)) {
      if (active.size === 1) return toast(this, "至少保留一个舞种");
      active.delete(label);
    } else {
      active.add(label);
    }
    this.activeStyles = [...active];
    this.setData({
      styleChips: (this.data.styleChips || []).map((c) => ({ ...c, on: active.has(c.label) })),
      styleAllOn: active.size === (this.data.styleChips || []).length,
      followsView: this.filterFollowsByStyle(this.allFollows || []),
    });
  },

  tapAllStyles() {
    const chips = this.data.styleChips || [];
    this.activeStyles = chips.map((c) => c.label);
    this.setData({
      styleChips: chips.map((c) => ({ ...c, on: true })),
      styleAllOn: true,
      followsView: this.filterFollowsByStyle(this.allFollows || []),
    });
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

  /**
   * 取消预约 / 删除录入课后：列表要重拉、待确认徽标要重算。
   * 徽标是按未确认预约数算的，漏掉这一步会出现「取消了但角标还在」。
   */
  afterChange() {
    this.loadAll();
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().refreshBadge();
    }
  },

  /** 还没约的课补一次「预约」：老看见一条毫无状态的课比多点一次按钮更烦 */
  async tapBookRow(e) {
    const id = Number(e.currentTarget.dataset.id);
    const row = (this.data.schedules || []).find((r) => r.id === id);
    if (!row) return;
    try {
      const res = await bookCourse(id, "MANUAL", row);
      // 撞课时用户会主动放弃，返回 null —— 那是他自己的决定，不是失败，别弹报错
      if (res === null) return;
      toast(this, "已约好", "success");
      this.afterChange();
    } catch (err) {
      toast(this, err.message);
    }
  },

  /**
   * 取消预约。
   *
   * 分岔点在「这节课是不是你自己录的」：
   *  - 抓取来的公共课：取消就是取消，课本身属于大家，动不得。
   *  - 自己录的课：取消完，那节课大概率也是不想留了 ——
   *    只删预约的话，课表里还杵着一条「我录的」，用户只会以为没取消成功。
   *    所以这里是三岔口：只取消预约 / 连课一起删 / 算了。
   */
  async tapCancelRow(e) {
    const id = Number(e.currentTarget.dataset.id);
    const row = (this.data.schedules || []).find((r) => r.id === id);
    if (!row) return;
    const name = row.courseName || "这节课";

    if (row.mine) {
      const idx = await choose({
        itemList: ["只取消预约", "连这节课一起删掉"],
        alert: `「${name}」是你自己录的课`,
      });
      if (idx < 0) return;
      if (idx === 1) {
        try {
          const res = await api.apiDeleteImport(id);
          toast(this, res && res.bookings ? "已删除，预约也一并清掉了" : "已删除", "success");
        } catch (err) {
          toast(this, err.message);
        }
        this.afterChange();
        return;
      }
    } else {
      const yes = await confirm({
        title: "取消预约",
        content: `确定取消「${name}」的预约吗？`,
        confirmText: "取消预约",
      });
      if (!yes) return;
    }

    try {
      const res = await api.apiCancelBooking(id);
      toast(
        this,
        res && res.reminderRemoved ? "已取消预约，开课提醒也关掉了" : "已取消预约",
        "success",
      );
    } catch (err) {
      toast(this, err.message);
    }
    this.afterChange();
  },

  /** 删掉一条自己录的课（不管约没约过） */
  async tapDeleteRow(e) {
    const id = Number(e.currentTarget.dataset.id);
    const row = (this.data.schedules || []).find((r) => r.id === id);
    const yes = await confirm({
      title: "删掉这节录入的课？",
      content: `「${(row && row.courseName) || "这节课"}」连同它的预约记录一起删掉，删了就找不回来了`,
      confirmText: "删除",
    });
    if (!yes) return;
    try {
      await api.apiDeleteImport(id);
      toast(this, "已删除", "success");
      this.afterChange();
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

/**
 * 「我的课表」：把「我约的课」和「我录的课」合成一张表。
 *
 * 这两个来源本来就在描述同一件事 —— 跟我有关的课 —— 只是进来时的姿势不同：
 * 约的课没有「谁录的」这层概念，录的课则可能压根没约过。以前它们分列两处，
 * 于是「补录完在预约记录里查不到」「之前录过的课找不着」同时成立：
 * 数据一直都在，只是从来没人把它们摆到一块儿看。
 *
 * @param {object[]} bookings /bookings 的返回（已带 statusLabel）
 * @param {object[]} mine     /imports/mine 的返回（带 bookingStatus / hasReminder）
 */
function buildMySchedule(bookings, mine) {
  const today = todayKey();
  const rows = new Map();

  for (const b of bookings || []) {
    const s = b.schedule || {};
    if (!s.id) continue;
    rows.set(s.id, {
      id: s.id,
      courseName: s.courseName || "未命名课程",
      studioName: s.studio || "",
      cityName: s.city || "",
      dateLabel: String(s.scheduleDate || "").slice(0, 10),
      startTime: s.startTime || "",
      endTime: s.endTime || "",
      coach: s.coach || "",
      booked: true,
      status: b.status,
      mine: false,
      hasReminder: false,
    });
  }

  // 没约过的录入课也要进来 —— 它们才是「录完就消失」那一批。
  // 已经在上面出现过（说明也约了）就只补标签，别插重复行。
  for (const r of mine || []) {
    if (!r.id) continue;
    const hit = rows.get(r.id);
    if (hit) {
      hit.mine = true;
      hit.hasReminder = Boolean(r.hasReminder);
      continue;
    }
    rows.set(r.id, {
      id: r.id,
      courseName: r.courseName || "未命名课程",
      studioName: r.studioName || "",
      cityName: r.cityName || "",
      dateLabel: String(r.date || "").slice(0, 10),
      startTime: r.startTime || "",
      endTime: r.endTime || "",
      coach: r.coachName || "",
      booked: Boolean(r.bookingStatus),
      status: r.bookingStatus || null,
      mine: true,
      hasReminder: Boolean(r.hasReminder),
    });
  }

  const list = [...rows.values()].map((r) => ({
    ...r,
    past: Boolean(r.dateLabel) && r.dateLabel < today,
    dateText: r.dateLabel
      ? `${r.dateLabel.slice(5)} ${WEEK[parseKey(r.dateLabel).getDay()]}`
      : "日期待定",
    // 来源与状态是两个维度：录的课也可能没约，约的课也可能是抓取来的
    sourceLabel: r.mine ? "我录的" : "抓取的",
    statusLabel: r.booked ? (r.status === "CONFIRMED" ? "已约" : "待确认") : "只记录",
    statusClass: r.booked ? (r.status === "CONFIRMED" ? "sk-ok" : "sk-warn") : "sk-dim",
  }));

  // 未来的课排前面；上过的沉到末尾并且倒序（最近一次上过的在最前）——
  // 把过期课压在最上面，用户每次进来都得翻一大截才看到今天要上的课。
  list.sort((a, b) => {
    const pa = a.past ? 1 : 0;
    const pb = b.past ? 1 : 0;
    if (pa !== pb) return pa - pb;
    const ka = a.dateLabel + a.startTime;
    const kb = b.dateLabel + b.startTime;
    return pa ? kb.localeCompare(ka) : ka.localeCompare(kb);
  });

  return list;
}