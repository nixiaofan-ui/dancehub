const app = getApp();
const api = require("../../services/api");
const { PLATFORM_LABEL, DIFF_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");
const { dateKey, addDays, todayKey, parseKey } = require("../../utils/date");
const { onNavTop } = require("../../utils/scroll-top");
const { onTapCoach } = require("../../utils/coach-nav");
const { foldBlocked } = require("../../utils/blocked");

const WEEK_LABEL = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const LV_LABEL = {
  BEGINNER: "LV1",
  INTERMEDIATE: "LV3",
  ADVANCED: "LV5",
  ALL_LEVELS: "LV?",
};

function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":");
  return h + ":" + m;
}

Page({
  onNavTop,

  // 点教练名 → 老师主页（cityId 从门店详情带，取不到走全局当前城市兜底）
  goCoach: onTapCoach,

  data: {
    studioId: null,
    studio: null,
    followed: false,
    loading: true,
    weekIndex: 1,
    weekSlots: [1, 2, 3],
    selectedKey: "",
    selectedTitle: "",
    weekDays: [],
    dayItems: [],
    bookedCount: 0,
    weekBookedCount: 0,
    // 多店模式：从品牌页/自选门店进来时走这套
    multiMode: false,
    multiTitle: "",
    stores: [], // [{id, short, name, count, hasClass}]
    activeStoreIds: [], // 当前勾选的门店，空数组语义=全不选
    allStoreIds: [],
    allOn: false, // 是否已全选 —— 决定右侧按钮显示「全选」还是「清除」
    // 被屏蔽的老师：课不直接消失，折叠成一行（点了展开才把课放回列表）
    foldedRows: [],
  },

  onLoad(query) {
    this.weeksCache = {};
    this.weekMonday = null;
    this.bookedIds = new Set();
    // 门店勾选只初始化一次，翻周不能把用户的勾选重置掉
    this._storesInited = false;

    // 多店入口：/pages/studio/weekly?ids=1,2,3&title=品牌名
    // 单店入口：/pages/studio/weekly?id=1 —— 保持原逻辑不变
    // first=1 表示「这些门店是品牌页自动带出来的，用户没表达过偏好」→ 默认只勾一家；
    // 自选组合页不带这个参数（那几家是他亲手挑的，砍掉就是 bug）
    const ids = query.ids ? query.ids.split(",").map(Number).filter(Boolean) : null;
    if (ids && ids.length) {
      this.multiMode = true;
      this.allStoreIds = ids;
      this.pickFirst = query.first === "1";
      this.setData({
        multiMode: true,
        multiTitle: decodeURIComponent(query.title || "多店课表"),
        activeStoreIds: this.pickFirst ? [] : ids,
        allOn: !this.pickFirst,
        selectedKey: todayKey(),
      });
      this.initWeek(new Date());
      return;
    }

    this.multiMode = false;
    this.studioId = Number(query.id);
    this.setData({ studioId: this.studioId, selectedKey: todayKey() });
    this.initWeek(new Date());
    this.loadStudio();
  },

  onShow() {
    // 从课程详情返回时预约可能已经取消/新增，课表上的标记得跟着变
    this.loadBookings();
    // 也可能刚在老师主页点了「不想看他的课」——屏蔽名单是本地的，
    // 回到这张表必须立刻生效，否则用户会以为屏蔽没用
    if (this.weekMonday) this.applyWeekData();
  },

  /**
   * 拉一次「我的预约」，只取 scheduleId 集合。
   * 失败就当没有预约 —— 看课表不该被登录状态打断，所以静默吞掉。
   */
  async loadBookings() {
    try {
      await api.ensureReady();
      const list = await api.apiBookings();
      this.bookedIds = new Set(
        (list || []).map((b) => b.schedule && b.schedule.id).filter((id) => id)
      );
    } catch (e) {
      this.bookedIds = new Set();
    }
    if (this.weeksCache && this.weekMonday) this.applyWeekData();
  },

  mondayOf(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay();
    return addDays(x, day === 0 ? -6 : 1 - day);
  },

  initWeek(center) {
    const monday = this.mondayOf(center);
    this.weekMonday = monday;
    this.buildWeek(monday);
    this.loadWeek(monday);
  },

  buildWeek(monday) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      days.push({
        key: dateKey(d),
        label: WEEK_LABEL[d.getDay()],
        num: d.getDate(),
        isToday: dateKey(d) === todayKey(),
      });
    }
    this.setData({ weekDays: days });
  },

  loadWeek(monday) {
    const from = dateKey(monday);
    const to = dateKey(addDays(monday, 6));
    if (this.weeksCache[from]) {
      this.applyWeekData();
      return;
    }
    this.setData({ loading: true });

    const request = this.multiMode
      ? api.apiMultiTimeline(this.allStoreIds, from, to)
      : api.apiStudioSchedules(this.studioId, from, to);

    request
      .then((res) => {
        let rows = res;
        // 多店接口把门店清单和课分开返回，先记住门店短名，
        // 卡片上要贴一枚「哪家店」的标签，但不该重复整个「品牌·分店」全名
        if (this.multiMode) rows = (res && res.items) || [];

        const grouped = {};
        (rows || []).forEach((s) => {
          if (!grouped[s.scheduleDate]) grouped[s.scheduleDate] = [];
          grouped[s.scheduleDate].push({
            id: s.id,
            studioId: s.studio ? s.studio.id : null,
            studioShort: s.studio ? s.studio.name : "",
            courseName: s.courseName,
            coachName: s.coach ? s.coach.name : "待定",
            startTime: s.startTime,
            endTime: s.endTime,
            timeLabel: formatTime(s.startTime) + " - " + formatTime(s.endTime),
            difficulty: s.difficulty,
            level: LV_LABEL[s.difficulty] || "LV?",
            diffLabel: DIFF_LABEL[s.difficulty] || s.difficulty,
            diffClass: (s.difficulty || "ALL_LEVELS").toLowerCase(),
            // 舞室官方系统的真实已约人数，null = 该平台不公开，模板里不显示热度
            bookedNum: s.bookedNum != null ? Number(s.bookedNum) : null,
          });
        });

        // 短名统一从 studios 列表取，保证 chip 和卡片标签一致
        if (this.multiMode && res && res.studios) {
          const shortMap = {};
          res.studios.forEach((s) => {
            shortMap[s.id] = s.short;
          });
          Object.values(grouped).forEach((list) => {
            list.forEach((i) => {
              if (shortMap[i.studioId]) i.studioShort = shortMap[i.studioId];
            });
          });

          // 必须先有 grouped 才能决定默认勾哪家（要按「今天有没有课」挑），
          // 所以门店初始化放在建完 grouped 之后
          if (!this._storesInited) {
            this._storesInited = true;
            const ids = this.pickDefaultStores(res.studios, grouped);
            this.setStoresOn(res.studios, ids);
          } else {
            // 翻周：只刷新门店课数，别动用户已经勾好的
            this.setStoresOn(res.studios, this.data.activeStoreIds);
          }
        }

        this.weeksCache[from] = grouped;
        this.applyWeekData();
      })
      .catch((e) => {
        this.weeksCache[from] = {};
        this.setData({ loading: false });
        toast(this, e.message);
      });
  },

  /**
   * 首次进入勾哪些门店。
   * - 自选组合进来：他亲手挑的那几家，全勾（砍成一家等于无视他的选择）
   * - 品牌页进来：默认只勾一家。十几家分店的课混在一屏根本看不过来，
   *   而且默认全选时「全选」按钮点了没反应，用户不知道怎么收回去。
   */
  pickDefaultStores(stores, grouped) {
    if (!this.pickFirst) return (stores || []).map((s) => s.id);
    if (!stores || !stores.length) return [];

    // 优先第一家，但它今天没课就换一家今天有课的 ——
    // 开局就是「当天暂无课程」，用户会以为这家品牌没排课
    const todayCount = {};
    (grouped[todayKey()] || []).forEach((i) => {
      todayCount[i.studioId] = (todayCount[i.studioId] || 0) + 1;
    });
    const hasToday = (s) => (todayCount[s.id] || 0) > 0;
    if (hasToday(stores[0])) return [stores[0].id];
    const withClass = stores.find(hasToday);
    if (withClass) return [withClass.id];

    // 今天全都没课 → 退到本周课最多的那家（至少翻一翻能看到课）
    return [stores.slice().sort((a, b) => (b.count || 0) - (a.count || 0))[0].id];
  },

  /** 写回门店 chip 的高亮状态 + 全选标记 */
  setStoresOn(stores, activeIds) {
    this.setData({
      stores: stores.map((s) => ({ ...s, on: activeIds.indexOf(s.id) >= 0 })),
      activeStoreIds: activeIds,
      // 拿返回的门店数比，别用 allStoreIds —— 服务端会过滤掉停业的店，
      // 两边长度不等时「全选」永远点不到，按钮就再也不会变成「清除」
      allOn: activeIds.length > 0 && activeIds.length === stores.length,
    });
  },

  tapStore(e) {
    const id = Number(e.currentTarget.dataset.id);
    const active = new Set(this.data.activeStoreIds);
    if (active.has(id)) active.delete(id);
    else active.add(id);
    this.applyStoreFilter([...active]);
  },

  /**
   * 全选 / 清除 二合一。
   * 全选状态下这个按钮就叫「清除」，点一下清空（配合空态提示引导他重新勾）
   */
  tapAllStores() {
    this.applyStoreFilter(this.data.allOn ? [] : [...this.allStoreIds]);
  },

  /**
   * 统一更新「勾选门店 + chip 高亮 + 当天课表」。
   * chip 的 on 字段在这里算好，不用 WXML 里做 indexOf
   * （小程序模板对数组方法支持不完整，写在数据里最稳）。
   */
  applyStoreFilter(activeIds) {
    const active = new Set(activeIds);
    const stores = (this.data.stores || []).map((s) => ({ ...s, on: active.has(s.id) }));
    this.setData({
      activeStoreIds: activeIds,
      stores,
      allOn: activeIds.length > 0 && activeIds.length === stores.length,
    });
    this.applyWeekData();
  },

  /**
   * 按当前勾选门店过滤某一天的课。
   * 周视图上的「今天有没有课」小圆点也要跟着过滤，
   * 否则会出现「日期上有课、点进去却空白」。
   */
  visibleOf(grouped, key) {
    let list = grouped[key] || [];
    if (this.multiMode) {
      const active = new Set(this.data.activeStoreIds);
      list = list.filter((i) => active.has(i.studioId));
    }
    return list;
  },

  /**
   * 展开 / 收起某位被屏蔽老师的课。
   * 收起状态下它们只剩一行提示，展开才把课插回列表（标成「已隐藏」样式）。
   */
  toggleFold(e) {
    const name = e.currentTarget.dataset.name;
    const shown = this.data._shownBlocked || {};
    if (shown[name]) delete shown[name];
    else shown[name] = true;
    this._shownBlocked = shown;
    this.applyWeekData();
  },

  applyWeekData() {
    const grouped = this.weeksCache[dateKey(this.weekMonday)] || {};
    const booked = this.bookedIds || new Set();

    const weekDays = this.data.weekDays.map((d) => {
      // 周视图小圆点只认「没被屏蔽」的课，否则会出现「这天有课，点进去是空的」
      const { visible } = this.splitByBlocked(grouped, d.key);
      return {
        ...d,
        hasClass: visible.length > 0,
        bookedCount: visible.filter((i) => booked.has(i.id)).length,
      };
    });

    const selectedKey = this.data.selectedKey || todayKey();
    const { visible, folded } = this.splitByBlocked(grouped, selectedKey);
    const shown = this._shownBlocked || {};
    const decorate = (i, hidden) => ({ ...i, booked: booked.has(i.id), hidden });

    const dayItems = visible.map((i) => decorate(i, false));
    folded.forEach((g) => {
      if (!shown[g.coachName]) return;
      g.items.forEach((i) => dayItems.push(decorate(i, true)));
    });
    // 展开的课要插回正确的时间位置，不能一股脑堆在列表最后
    dayItems.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

    this.setData({
      weekDays,
      loading: false,
      selectedKey,
      selectedTitle: this.dayTitle(selectedKey),
      dayItems,
      foldedRows: folded.map((g) => ({
        coachName: g.coachName,
        count: g.count,
        open: !!shown[g.coachName],
      })),
      bookedCount: dayItems.filter((i) => i.booked).length,
      weekBookedCount: weekDays.reduce((n, d) => n + d.bookedCount, 0),
    });
  },

  /** 某一天的课按「是否被屏蔽」分成两组 */
  splitByBlocked(grouped, key) {
    return foldBlocked(this.visibleOf(grouped, key), (i) => i.coachName);
  },

  dayTitle(key) {
    const d = parseKey(key);
    return d.getMonth() + 1 + "月" + d.getDate() + "日 · " + WEEK_CN[d.getDay()];
  },

  selectDay(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.selectedKey) return;
    this.setData({ selectedKey: key });
    // 重算而不是直接取缓存切片：多店模式还要按勾选门店过一遍
    this.applyWeekData();
  },

  onWeekChange(e) {
    const cur = e.detail.current;
    const dir = cur === 0 ? -1 : cur === 2 ? 1 : 0;
    if (!dir) return;
    this.weekMonday = addDays(this.weekMonday, dir * 7);
    this.buildWeek(this.weekMonday);
    this.setData({ weekIndex: 1 });
    this.loadWeek(this.weekMonday);
  },

  prevWeek() {
    this.moveWeek(-1);
  },

  nextWeek() {
    this.moveWeek(1);
  },

  moveWeek(dir) {
    this.weekMonday = addDays(this.weekMonday, dir * 7);
    this.buildWeek(this.weekMonday);
    this.setData({ weekIndex: 1 });
    this.loadWeek(this.weekMonday);
  },

  goToday() {
    const monday = this.mondayOf(new Date());
    this.weekMonday = monday;
    this.buildWeek(monday);
    this.setData({ weekIndex: 1, selectedKey: todayKey() });
    this.loadWeek(monday);
  },

  goCourse(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/course/detail?id=" + id });
  },

  async loadStudio() {
    await api.ensureReady();
    try {
      const [detail, follows] = await Promise.all([
        api.apiStudioDetail(this.studioId),
        api.apiFollows(),
      ]);
      this.setData({
        studio: {
          ...detail,
          cityName: detail.city ? detail.city.name : "",
          platformLabel: PLATFORM_LABEL[detail.platform] || detail.platform,
        },
        followed: follows.some((f) => f.studio.id === this.studioId),
      });
    } catch (e) {
      toast(this, e.message);
    }
  },

  async toggleFollow() {
    try {
      if (this.data.followed) {
        await api.apiUnfollow(this.studioId);
      } else {
        await api.apiFollow(this.studioId);
      }
      this.setData({ followed: !this.data.followed });
      toast(this, this.data.followed ? "已关注" : "已取消关注", "success");
    } catch (err) {
      toast(this, err.message);
    }
  },
});
