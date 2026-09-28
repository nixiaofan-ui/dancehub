const app = getApp();
const api = require("../../services/api");
const { PLATFORM_LABEL, DIFF_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");
const { dateKey, addDays, todayKey, parseKey } = require("../../utils/date");
const { onNavTop } = require("../../utils/scroll-top");

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
    activeStoreIds: [], // 当前勾选的门店，空数组语义=全不选（初始化时会置为全选）
    allStoreIds: [],
  },

  onLoad(query) {
    this.weeksCache = {};
    this.weekMonday = null;
    this.bookedIds = new Set();

    // 多店入口：/pages/studio/weekly?ids=1,2,3&title=品牌名
    // 单店入口：/pages/studio/weekly?id=1 —— 保持原逻辑不变
    const ids = query.ids ? query.ids.split(",").map(Number).filter(Boolean) : null;
    if (ids && ids.length) {
      this.multiMode = true;
      this.allStoreIds = ids;
      this.setData({
        multiMode: true,
        multiTitle: decodeURIComponent(query.title || "多店课表"),
        activeStoreIds: ids,
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
        if (this.multiMode) {
          rows = (res && res.items) || [];
          if (res && res.studios) {
            // 首次进入默认全选：用户是从「这个品牌」点进来的，
            // 他想看的就是全部门店，让他自己关掉比让他一家家打开更省事
            const ids = this.data.activeStoreIds.length
              ? this.data.activeStoreIds
              : res.studios.map((s) => s.id);
            const active = new Set(ids);
            this.setData({
              stores: res.studios.map((s) => ({ ...s, on: active.has(s.id) })),
              activeStoreIds: ids,
            });
          }
        }

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
   * 多店模式下的门店勾选。
   * 至少保留一家 —— 全不选会得到一个空列表，用户会以为没课或接口坏了。
   */
  tapStore(e) {
    const id = Number(e.currentTarget.dataset.id);
    const active = new Set(this.data.activeStoreIds);
    if (active.has(id)) {
      if (active.size === 1) return toast(this, "至少保留一家门店");
      active.delete(id);
    } else {
      active.add(id);
    }
    this.applyStoreFilter([...active]);
  },

  tapAllStores() {
    this.applyStoreFilter([...this.allStoreIds]);
  },

  /**
   * 统一更新「勾选门店 + chip 高亮 + 当天课表」。
   * chip 的 on 字段在这里算好，不用 WXML 里做 indexOf
   * （小程序模板对数组方法支持不完整，写在数据里最稳）。
   */
  applyStoreFilter(activeIds) {
    const active = new Set(activeIds);
    const stores = (this.data.stores || []).map((s) => ({ ...s, on: active.has(s.id) }));
    this.setData({ activeStoreIds: activeIds, stores });
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

  applyWeekData() {
    const grouped = this.weeksCache[dateKey(this.weekMonday)] || {};
    const booked = this.bookedIds || new Set();

    const weekDays = this.data.weekDays.map((d) => {
      const list = this.visibleOf(grouped, d.key);
      return {
        ...d,
        hasClass: list.length > 0,
        bookedCount: list.filter((i) => booked.has(i.id)).length,
      };
    });

    const selectedKey = this.data.selectedKey || todayKey();
    const dayItems = this.visibleOf(grouped, selectedKey).map((i) => ({
      ...i,
      booked: booked.has(i.id),
    }));

    this.setData({
      weekDays,
      loading: false,
      selectedKey,
      selectedTitle: this.dayTitle(selectedKey),
      dayItems,
      bookedCount: dayItems.filter((i) => i.booked).length,
      weekBookedCount: weekDays.reduce((n, d) => n + d.bookedCount, 0),
    });
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
