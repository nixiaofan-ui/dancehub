const app = getApp();
const api = require("../../services/api");
const jump = require("../../services/jump");
const { dateKey, addDays, todayKey, formatChip } = require("../../utils/date");
const { DIFF_LABEL } = require("../../utils/constants");
const { API_HOST } = require("../../utils/config");
const { requestSubscribe } = require("../../utils/subscribe");
const { toast } = require("../../utils/toast");
const { confirm, choose } = require("../../utils/confirm");
const { bookCourse } = require("../../utils/booking");
const { locateCity, openSetting } = require("../../utils/locate");
const { isBlocked } = require("../../utils/blocked");
const { isFav } = require("../../utils/fav-coaches");
const { timeAgo } = require("../../utils/time-ago");
const { onNavTop } = require("../../utils/scroll-top");
// 跳老师主页统一走这里：详情页/周课表页也是同一个实现，行为保持一致
const { onTapCoach } = require("../../utils/coach-nav");
const CP = require("../../utils/city-picker-mixin");
const prefs = require("../../utils/prefs");
const {
  styleOfCourse,
  buildStyleChips,
  filterByStyle,
  toggleAllActive,
  isAllOn,
} = require("../../utils/style-filter");

/**
 * 首页和发现页共用一套城市选择逻辑（热门 chip + 全量面板）。
 * mixin 放前面、页面自己的定义放后面：index 页有 tapLocate（带授权引导的完整版），
 * 要盖掉 mixin 里的简版，所以顺序不能反。
 */
Page(
  Object.assign({}, CP.methods, {
  onNavTop,

  data: Object.assign({}, CP.data, {
    region: "CN",
    cities: [],
    filteredCities: [],
    cityId: null,
    locating: false,

    dates: [],
    swiperCurrent: 1,
    currentKey: "",

    items: [],
    pendingCount: 0,
    loading: false,
    // 加载失败的常驻错误提示（空串表示正常）。见 load() 的 catch。
    loadError: "",

    // 已关注门店筛选条
    storeChips: [],
    showStoreBar: false,
    // 门店条是否处于全选态（决定右侧那颗按钮显示「全选」还是「清除」）
    storeAllOn: true,
    // 舞种筛选条（课名里天然带舞种，本地识别即可，不用等服务端发版）
    styleChips: [],
    showStyleBar: false,
    styleAllOn: true,
    // 列表空着，但原因是「被筛掉了」而不是「这天没课」——空态文案靠它分岔
    emptyFiltered: false,
    // 空态的具体归因：filtered（门店/舞种筛掉了）/ no-booked（这天确实没约）/
    // booked-hidden（已约的课被门店/舞种挡住）/ booked-blocked（已约的课在屏蔽教练那层）
    // ⚠ 只看已约开着 + 已约计数 > 0 时列表却空着，原因绝不是「没约课」——
    //   文案归因错了，用户照提示关掉开关列表还是空，只会更懵（线上真实事故）
    emptyReason: "",
    // 因「屏蔽老师」而隐藏的课
    hiddenCount: 0,
    showBlocked: false,
    /**
     * 「只看已约」开关。默认关：课表的主职还是「我今天能上什么」，
     * 一上来就只给已约的课，等于把这张表变成了另一份「预约记录」。
     *
     * ⚠ 已约置顶（sortBookedFirst）**不受这个开关影响**，是常驻行为：
     * 一天几十节课里，用户第一件事往往是确认「我约的那节在几点」，
     * 置顶比开关更高频，也不挡住别的课。
     */
    onlyBooked: false,
    // 这天已约（含待确认）的课数，写在开关旁边；为 0 时开关整体收起
    bookedCount: 0,

    panel: { visible: false, item: null },

    /**
     * 「你的预约在别的城市」提示条（null = 不显示）：{ id, region, name, count }。
     * ⚠ 只提示、不切城市 —— 见 checkBookedCityHint 的说明。
     */
    cityHint: null,
  }),

  async onLoad() {
    this.currentDate = new Date();
    // 全局「预约/关注/提醒」写操作计数，用来判断课表数据是否被弄脏
    this.seenDirty = app.globalData.dirty || 0;
    const g = app.globalData;
    this.setData(this.syncCityView(g.region, g.cityId, g.cities || []));
    // 恢复上次的筛选：门店筛选挂钩城市（换城市旧勾选本就不适用），
    // 舞种是全国统一口径，跨城市照旧。null = 从没筛过（首屏全选）。
    this.activeIds = prefs.readHomeStores(g.cityId);
    this.activeStyles = prefs.readHomeStyles();
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

    // 后台定位刚落地：切过去并说明
    const located = g.locatedCity;
    if (located && located.id !== this.data.cityId) {
      g.locatedCity = null;
      this.cityHintOff = false;
      this.setData({
        ...this.syncCityView(located.region, located.id, g.cities || []),
        cityHint: null,
      });
      toast(this, `已定位到${located.name}`);
      // ⚠ 切完也要看一眼「预约是否落在刚才那座城」：定位晚到时用户是
      //   被我们拽走的，原城市若有今天的预约，这屏就该给提示条，
      //   不能等他下次切 tab 回来才补（那之前是一屏解释不了的空白）。
      await this.checkBookedCityHint();
      this.load();
      return;
    }

    if (this.data.region !== g.region || this.data.cityId !== g.cityId) {
      // 城市在别处（或本页）被换掉了，以最新值渲染一遍。
      // 旧城市算出来的「预约在别城」提示跟着作废，重算（refreshCityHint）。
      this.setData(this.syncCityView(g.region, g.cityId, g.cities || []));
      this.refreshCityHint();
      this.load();
      return;
    }
    const dirty = g.dirty || 0;
    const needFollow = !this.cityChecked || dirty !== this.seenDirty;
    this.cityChecked = true;
    this.seenDirty = dirty;

    // 刚约完课 / 首次进课表：看一眼预约是不是落在别的城市（只提示，不切城市）
    if (needFollow) {
      await this.checkBookedCityHint();
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
   * 看一眼「预约是不是落在别的城市」，但**只提示、不切城市**。
   *
   * 预约经常是在发现页/搜索里跨城市发生的：回到课表，当前城市一节都看不到，
   * 用户只能自己想起来去切城市。早先这里是直接把城市切过去 ——
   * 但那会和「每次启动定位」打架：人明明在上海，课表却被拽去北京，
   * 观感是「我选的城市又被吞了」（用户反馈的就是这个毛病）。
   * 所以改成顶部一条可点的提示条：不抢方向盘，信息也不丢，点一下才切。
   *
   * 三条口径：
   *   1) 只统计今天及以后的预约 —— 上过的课不该一直挂着提示
   *   2) 当前城市本来就有预约 → 不提示（没什么可提醒的）
   *   3) 用户关掉过（cityHintOff）→ 本次会话不再出现
   */
  async checkBookedCityHint() {
    if (this.cityHintOff) return;
    let list;
    try {
      list = await api.apiBookings();
    } catch (e) {
      return; // 没登录或接口挂了：静默保持原样，不打扰
    }
    if (!Array.isArray(list) || !list.length) return;

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
    if (!counts.size) return;

    const cities = app.globalData.cities || [];
    const cur = cities.find((c) => c.id === this.data.cityId);
    if (cur && counts.has(cur.name)) {
      // 当前城市就有预约，这条提示没有意义；上一轮留下的要撤掉
      if (this.data.cityHint) this.setData({ cityHint: null });
      return;
    }

    // 多座城市都有预约时，取课最多的那座
    const [name, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const city =
      cities.find((c) => c.name === name && c.region === this.data.region) ||
      cities.find((c) => c.name === name);
    if (!city || city.id === this.data.cityId) return;

    this.setData({
      cityHint: { id: city.id, region: city.region, name: city.name, count: n },
    });
  },

  /**
   * 点提示条 = 用户表态「我要看那座城市」，这时候才切。
   * 按 manual 记：本次会话里，迟到的定位结果不能再把他拽回来。
   */
  async tapCityHint() {
    const h = this.data.cityHint;
    if (!h) return;
    app.setCity(h.region, h.id, "manual");
    this.setData({
      ...this.syncCityView(h.region, h.id, app.globalData.cities || []),
      cityHint: null,
    });
    toast(this, `已切到${h.name}`);
    await this.load();
  },

  /** 关掉提示条：本次会话不再提示（换城市后重新计算） */
  dismissCityHint() {
    this.cityHintOff = true;
    this.setData({ cityHint: null });
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
    // 静默刷新（onShow 触发）不动 loading，否则每次切回 tab 都闪一下骨架屏
    if (!silent) this.setData({ loading: true });
    const key = dateKey(this.currentDate);
    try {
      // ensureReady 必须包在 try 里：它 await 的是 app.ready，
      // 服务不可达时会直接抛，放在外面就成了没人接的 rejection，
      // 界面停在空白上，连一句失败原因都没有。
      await api.ensureReady();
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
          // 常看的老师：课表里给个星标，让「标了爱师」这件事真的看得见
          fav: isFav(item.coach ? item.coach.name : ""),
          edgeClass: "edge-" + (item.difficulty || "ALL_LEVELS").toLowerCase(),
          slotClass,
          slotText,
          // 人数是抓取快照（热刷新 20 分钟一轮、常规 6 小时一轮），
          // 标出它有多旧，免得用户拿官方小程序一对以为是我们算错了
          bookedAgo: item.bookedNum > 0 ? timeAgo(item.bookedAt) : "",
        };
      });
      // 两级过滤都在本地做：数据是当天整城拉回来的，
      // 第一级剔掉屏蔽老师的课，第二级按勾选的门店筛 —— 都不用重新请求
      this.rawItems = items;
      const hidden = items.filter((i) => !this.isVisibleCoach(i)).length;
      const base = this.data.showBlocked ? items : items.filter((i) => this.isVisibleCoach(i));

      this.syncStoreChips(base);
      this.syncStyleChips(base);
      // 计数用**全量** items（含被屏蔽的）：开关上写的是「这天我约了几节」，
      // 跟着隐藏状态变会让这个数字和「我的」里的预约记录对不上
      const bookedCount = items.filter((i) => !!i.bookingStatus).length;
      // 翻到一节已约都没有的那天：开关继续开着就是一片空白，自动退回全部。
      // ⚠ 只在这一天关掉，翻回有预约的那天要再点一次 —— 空列表比「开关自己关了」更难解释
      if (this.data.onlyBooked && !bookedCount) this.setData({ onlyBooked: false });
      const visible = this.applyFilters(base);
      const pendingCount = items.filter((i) => i.bookingStatus === "PENDING").length;

      // 藏了多少课要让用户看见，别悄悄替他做决定
      const hiddenCount = this.data.showBlocked ? 0 : hidden;

      this.commitVisible(visible, {
        pendingCount,
        hiddenCount,
        bookedCount,
        loading: false,
        loadError: "",
      });
      this.allItems = base;
      this.lastLoadedAt = Date.now();
      this.seenDirty = app.globalData.dirty || 0;
    } catch (e) {
      this.lastLoadedAt = Date.now();
      // 后台静默刷新失败就不弹提示了：用户没主动操作，不该被报错打断
      if (silent) {
        this.setData({ loading: false });
        return;
      }
      // 服务不可达时只弹一闪而过的 toast 是不够的 —— toast 消失后界面仍是一片空白，
      // 用户分不清是「今天没课」还是「小程序坏了」。留一条常驻错误条 + 重试入口。
      this.setData({ loading: false, loadError: e.message || "加载失败" });
      toast(this, e.message);
    }
  },

  /** 错误条点击重试：清掉错误态重新拉一次，别让用户只能杀掉小程序重进 */
  reload() {
    this.setData({ loadError: "" });
    this.load();
  },

  /**
   * 构建「已关注门店」筛选条。
   * 只有 1 家时不显示 —— 只有一个选项的开关是纯粹的噪音。
   */
  syncStoreChips(items) {
    // ⚠ 换城市要重新取勾选：上个城市的门店 id 在这个城市里一家都对不上，
    //   带着这份勾选等于把列表整个筛空。判据必须是 cityId —— 只看「交集为空」
    //   不够，因为用户主动「清除」时交集也是空，而那种情况必须保住空态。
    //   切回来时也顺带把那个城市自己的勾选恢复出来。
    if (this._storeCityId !== undefined && this._storeCityId !== this.data.cityId) {
      this.activeIds = prefs.readHomeStores(this.data.cityId);
    }
    this._storeCityId = this.data.cityId;

    const map = new Map();
    items.forEach((i) => {
      const sid = i.studio && i.studio.id;
      if (!sid) return;
      if (!map.has(sid)) {
        map.set(sid, { id: sid, short: i.studio.short || i.studio.name, count: 0 });
      }
      map.get(sid).count += 1;
    });
    const chips = [...map.values()].sort((a, b) => b.count - a.count);

    // 保留用户上次的勾选，但要先跟「当前可选项」对齐：门店下架、换城市
    // （旧勾选在新城市里一家都对不上）都会自动回到全选。
    // ⚠ 用户点过「清除」（activeIds=[]）必须保持清除 —— 这个方法每次 load 都跑，
    //   把空数组当成「首次」重新全选的话，清除按钮就永远失效了。
    const aligned = prefs.alignPicked(this.activeIds, chips, (c) => c.id);
    const ids = aligned == null ? chips.map((c) => c.id) : aligned;
    this.activeIds = ids;

    const active = new Set(ids);
    this.setData({
      storeChips: chips.map((c) => ({ ...c, on: active.has(c.id) })),
      showStoreBar: chips.length > 1,
      storeAllOn: isAllOn(chips, ids),
    });
  },

  /**
   * ⚠ `activeIds` 的 null 与 [] 是两种意思，别合并：
   *   null = 还没初始化（首屏），全部放行；[] = 用户按了「清除」，一家都不该出现。
   * 之前写成 `!length` 就放行，导致点「清除」等于什么都没发生。
   */
  filterByStore(items) {
    if (!this.activeIds) return items;
    const active = new Set(this.activeIds);
    return items.filter((i) => i.studio && active.has(i.studio.id));
  },

  /**
   * 构建舞种筛选条。
   *
   * ⚠ 计数用**未经过门店筛选**的那份（base），不跟着门店勾选变：
   * 否则用户取消勾选一家店，舞种条上的数字和 chip 数量就跟着跳，
   * 看起来像筛选条自己坏了。
   *
   * ⚠ 「认不出舞种」的课归到「其它」，不能丢 —— 那批课也是用户想看的。
   */
  /** 首页按「课」筛：一节课只有一个舞种 */
  syncStyleChips(items) {
    const r = buildStyleChips(
      items,
      (i) => [styleOfCourse(i.courseName)],
      this.activeStyles,
      this._styleLabels,
    );
    this.activeStyles = r.active;
    this._styleLabels = r.labels;
    this.setData({
      styleChips: r.chips,
      showStyleBar: r.show,
      styleAllOn: isAllOn(r.chips, r.active),
    });
  },

  filterByStyle(items) {
    return filterByStyle(items, (i) => [styleOfCourse(i.courseName)], this.activeStyles);
  },

  /**
   * 门店/舞种勾选落盘 —— 用户下次进小程序不用重新勾一遍。
   * 只在用户真的点了筛选时调用，别在 sync 里顺手写：那样每次 load 都会写一次存储。
   */
  persistStorePick() {
    prefs.writeHomeStores(this.data.cityId, this.activeIds);
  },

  persistStylePick() {
    prefs.writeHomeStyles(this.activeStyles);
  },

  /**
   * 写回筛选结果时顺手算空态原因。
   * 「有课但被筛掉了」和「这天本来就没课」是两回事，
   * 空态文案说错，用户只会以为我们漏抓了数据。
   */
  commitVisible(items, extra) {
    const base = this.allItems || [];
    const emptyFiltered = base.length > 0 && items.length === 0;
    this.setData(
      Object.assign(
        {
          items,
          emptyFiltered,
          emptyReason: emptyFiltered ? this.diagEmpty(base) : "",
        },
        extra,
      ),
    );
  },

  /**
   * 空态归因：列表被筛空时，说清「被哪层筛掉的」。
   *
   * 已约计数（bookedCount）按全量课算、不受筛选影响，所以存在这种组合：
   * 开关写「已约 3 节」，列表却空着 —— 此时原因只能是已约的课被某层挡住了：
   *   - booked-hidden：被门店/舞种筛选挡住（在 base 里，只是没进可见列表）；
   *   - booked-blocked：整层被「屏蔽教练」滤掉（根本没进 base）；
   *   - no-booked：这天确实一节已约都没有（计数为 0，文案可以老实说）。
   */
  diagEmpty(base) {
    if (!this.data.onlyBooked) return "filtered";
    const bookedFull = (this.rawItems || base).filter((i) => !!i.bookingStatus).length;
    if (bookedFull === 0) return "no-booked";
    const bookedInBase = base.filter((i) => !!i.bookingStatus).length;
    return bookedInBase === 0 ? "booked-blocked" : "booked-hidden";
  },

  /**
   * 空态里的一键恢复：清掉门店/舞种筛选，回到「没在筛」。
   *
   * ⚠ 存储要写 null（删掉字段、回到「从没筛过」），不能把当前全量清单
   *   写死进去 —— 写死的话，之后新出现的门店/舞种会被这份旧勾选悄悄挡住。
   */
  resetFilters() {
    this.activeIds = null;
    this.activeStyles = null;
    prefs.writeHomeStores(this.data.cityId, null);
    prefs.writeHomeStyles(null);
    const base = this.allItems || [];
    this.syncStoreChips(base);
    this.syncStyleChips(base);
    this.commitVisible(this.applyFilters(base));
  },

  /**
   * 串起所有筛选：门店 → 舞种 → 已约 → 置顶。
   * 顺序不影响结果，但只调这一个地方不容易漏。
   */
  applyFilters(items) {
    return this.sortBookedFirst(
      this.filterByBooked(this.filterByStyle(this.filterByStore(items))),
    );
  },

  /**
   * 已约课置顶。
   *
   * 一天几十节课时，「我约的那节在几点」是最高频的问题 —— 置顶让它不用翻。
   * 顺序：已约好 > 待确认 > 没约；同档内保持原顺序（就是时间先后），
   * 自己带 idx 做 tiebreak，别指望引擎的 sort 稳定性。
   */
  sortBookedFirst(items) {
    const rank = (i) =>
      i.bookingStatus === "CONFIRMED" ? 0 : i.bookingStatus === "PENDING" ? 1 : 2;
    return items
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => rank(a.item) - rank(b.item) || a.idx - b.idx)
      .map((x) => x.item);
  },

  /** 「只看已约」：已约好和待确认都算已约 —— 两者都是用户主动标过的 */
  filterByBooked(items) {
    return this.data.onlyBooked ? items.filter((i) => !!i.bookingStatus) : items;
  },

  toggleOnlyBooked() {
    this.setData({ onlyBooked: !this.data.onlyBooked });
    this.commitVisible(this.applyFilters(this.allItems || []));
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
    const chips = this.data.styleChips || [];
    this.setData({
      styleChips: chips.map((c) => ({ ...c, on: active.has(c.label) })),
      styleAllOn: isAllOn(chips, [...active]),
    });
    this.persistStylePick();
    this.commitVisible(this.applyFilters(this.allItems || []));
  },

  /**
   * 全选 / 清除 二合一（与分店条一致）。
   * 清除后一节课都不剩 —— 这不是错误状态，是用户刚做的选择，
   * 所以空态要讲清楚是被筛掉的，别让他以为是这天没课。
   */
  tapAllStyles() {
    const chips = this.data.styleChips || [];
    const active = toggleAllActive(chips, this.data.styleAllOn);
    this.activeStyles = active;
    this.setData({
      styleChips: chips.map((c) => ({ ...c, on: active.indexOf(c.label) >= 0 })),
      styleAllOn: isAllOn(chips, active),
    });
    this.persistStylePick();
    this.commitVisible(this.applyFilters(this.allItems || []));
  },

  /**
   * 没被屏蔽的老师。
   * 屏蔽名单可能刚被改过（从老师页返回），所以每次渲染重新读 Storage，
   * 不在 page 实例上缓存。
   */
  isVisibleCoach(item) {
    const name = item.coach ? item.coach.name : item.coachName;
    return !isBlocked(name);
  },

  toggleShowBlocked() {
    const show = !this.data.showBlocked;
    this.setData({ showBlocked: show });
    const raw = this.rawItems || [];
    const base = show ? raw : raw.filter((i) => this.isVisibleCoach(i));
    this.syncStoreChips(base);
    this.syncStyleChips(base);
    this.allItems = base;
    this.commitVisible(this.applyFilters(base), { hiddenCount: 0 });
  },

  // 点教练名 → 老师主页（与详情页、周课表页共用 utils/coach-nav）
  goCoach: onTapCoach,

  tapStoreChip(e) {
    const id = Number(e.currentTarget.dataset.id);
    const active = new Set(this.activeIds || []);
    if (active.has(id)) {
      if (active.size === 1) return toast(this, "至少保留一家门店");
      active.delete(id);
    } else {
      active.add(id);
    }
    this.activeIds = [...active];
    const chips = this.data.storeChips || [];
    this.setData({
      storeChips: chips.map((c) => ({ ...c, on: active.has(c.id) })),
      storeAllOn: isAllOn(chips, [...active]),
    });
    this.persistStorePick();
    this.commitVisible(this.applyFilters(this.allItems || []));
  },

  /**
   * 全选 / 清除 二合一（与舞种条一致）。
   * 清除 = 一家店都不选，列表自然清空 —— 这是用户刚做的选择，不是出错，
   * 所以空态必须说明「点上方全选恢复」，别让他以为这天没课。
   */
  tapAllStores() {
    const chips = this.data.storeChips || [];
    const active = toggleAllActive(chips, this.data.storeAllOn, "id");
    this.activeIds = active;
    this.setData({
      storeChips: chips.map((c) => ({ ...c, on: active.indexOf(c.id) >= 0 })),
      storeAllOn: isAllOn(chips, active),
    });
    this.persistStorePick();
    this.commitVisible(this.applyFilters(this.allItems || []));
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
    app.setCity(region, city.id, "manual");
    this.setData(this.syncCityView(region, city.id, cities));
    this.refreshCityHint();
    this.load();
  },

  selectCity(e) {
    const cityId = e.currentTarget.dataset.id;
    if (cityId === this.data.cityId) return;
    this.applyCity(cityId);
  },

  /**
   * 点「📍 定位」：授权后把课表切到自己所在的城市。
   *
   * 三种失败要分开处理，否则用户只会看到「点了没反应」：
   *   denied      —— 之前拒绝过，系统不再弹窗，必须引导去设置页
   *   no-match    —— 定位成功，但所在地还没接入舞室（给出最近的有课城市）
   *   unsupported —— 基础库太老 / 后台没开通模糊定位接口
   */
  async tapLocate() {
    if (this.data.locating) return;
    this.setData({ locating: true });
    try {
      const r = await locateCity({});
      if (r.code === "ok") {
        this.applyLocated(r.city);
        return;
      }
      if (r.code === "denied") {
        const yes = await confirm({
          title: "需要定位权限",
          content: "你之前拒绝了定位授权，微信不会再弹窗。去设置里打开「使用我的地理位置」，就能自动显示你所在城市的课表。",
          confirmText: "去设置",
        });
        if (!yes) return;
        const state = await openSetting();
        if (state !== "granted") {
          toast(this, "仍未开启定位，可手动选择城市");
          return;
        }
        const again = await locateCity({});
        if (again.code === "ok") this.applyLocated(again.city);
        else toast(this, "定位失败，可手动选择城市");
        return;
      }
      if (r.code === "no-match") {
        const near = (r.nearest || []).map((n) => n.name).join("、");
        wx.showModal({
          title: "你所在的城市还没接入",
          content: near
            ? "目前离你最近的有课城市是：" + near + "。可以先看这些城市，也可以去「发现」页告诉我们你想看哪家舞室。"
            : "你所在的城市暂时没有收录舞室，去「发现」页告诉我们你想看哪家舞室吧。",
          showCancel: false,
        });
        return;
      }
      if (r.code === "unsupported") {
        toast(this, "当前微信版本不支持定位，请手动选择城市");
        return;
      }
      toast(this, "定位失败，请手动选择城市");
    } finally {
      this.setData({ locating: false });
    }
  },

  /**
   * 换城市之后重算提示条。
   *
   * 提示条的内容是「相对当前城市」算出来的：换了城市，上一轮算的结论就过期了
   * ——留在屏上会出现自相矛盾的文案（人已经在深圳，还写着「你在深圳还有 3 节预约」）。
   * 所以每次城市变化都要先清掉再重算，而不是只在 onShow 里碰运气。
   */
  refreshCityHint() {
    this.cityHintOff = false; // 换了城市就是新上下文，允许重新提示
    if (this.data.cityHint) this.setData({ cityHint: null });
    this.checkBookedCityHint();
  },

  applyLocated(city) {
    const cities = app.globalData.cities || [];
    // source 记 locate 而不是 manual：定位是系统给的，不算用户表态 ——
    // 但本次会话里它已经是「用户点过定位」的结果，晚到的后台定位不会再覆盖。
    app.setCity(city.region, city.id, "locate");
    this.setData(this.syncCityView(city.region, city.id, cities));
    toast(this, `已定位到${city.name}`);
    this.refreshCityHint();
    this.load();
  },

  /**
   * 城市被选中的统一出口：chip、城市面板、定位都收敛到这里。
   * 用 mixin 的 syncCityView 统一算 chip/热门/当前名，避免三处各写一遍
   * setData 之后状态不同步（典型症状：面板里选中了拉萨，回到页面 chip 条还停在热门上）。
   */
  applyCity(cityId) {
    app.setCity(this.data.region, cityId, "manual");
    this.setData(this.syncCityView(this.data.region, cityId, this.data.cities));
    this.refreshCityHint();
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

  /**
   * 取消预约。
   *
   * ⚠ 自己录的课要额外问一句。录课时那节课多半是为自己留的位置，
   *   只删预约的话，课表里那条「我录的」还原样杵着 ——
   *   用户看到的画面和他期望的「这节课跟我没关系了」差得很远，
   *   于是就有了「取消预约了怎么课还在」这个经典误会。
   *   给一条「连课一起删」的路，比让人猜下一步该去哪儿删要强得多。
   */
  async cancelBooking() {
    const item = this.data.panel.item;
    if (!item) return;

    if (item.mine) {
      const idx = await choose({
        itemList: ["只取消预约", "连这节课一起删掉"],
        alert: `「${item.courseName || "这节课"}」是你自己录的课`,
      });
      if (idx < 0) return;
      if (idx === 1) return this.deleteOwnCourse(item);
    } else {
      const yes = await confirm({
        title: "取消预约",
        content: `确定取消「${item.courseName || "这节课"}」的预约吗？`,
        confirmText: "取消预约",
      });
      if (!yes) return;
    }

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

  /** 删掉一条自己录的课（服务端会把它的预约与提醒一并清掉） */
  async deleteOwnCourse(item) {
    try {
      const res = await api.apiDeleteImport(item.id);
      this.setData({ panel: { visible: false, item: null } });
      this.refreshBadge();
      toast(this, res && res.bookings ? "已删除，预约也一并清掉了" : "已删除", "success");
      this.load();
    } catch (e) {
      toast(this, e.message);
    }
  },

  /**
   * 补录：从课表页直接进，带上当前城市和选中的那一天。
   *
   * 真实场景是「翻到某天发现这家店的课没抓到，就地补上」，而不是
   * 「专门去菜单里找录入入口」—— 后者多数人根本想不到要去。
   */
  goImport() {
    // cityName 来自 city-picker-mixin 的 syncCityView，与 chip 条上显示的是同一个值
    const cityName = this.data.cityName || "";
    const url =
      "/pages/import/import?date=" +
      (this.data.currentKey || "") +
      (this.data.cityId ? "&cityId=" + this.data.cityId : "") +
      (cityName ? "&cityName=" + encodeURIComponent(cityName) : "");
    wx.navigateTo({ url });
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
}));