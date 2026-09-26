const app = getApp();
const api = require("../../services/api");
const { PLATFORM_LABEL, DIFF_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");
const { dateKey, addDays, todayKey, parseKey } = require("../../utils/date");

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
  },

  onLoad(query) {
    this.studioId = Number(query.id);
    this.weeksCache = {};
    this.weekMonday = null;
    this.bookedIds = new Set();
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
    if (this.weeksCache[from]) {
      this.applyWeekData();
      return;
    }
    this.setData({ loading: true });
    api
      .apiStudioSchedules(this.studioId, from, dateKey(addDays(monday, 6)))
      .then((res) => {
        const grouped = {};
        (res || []).forEach((s) => {
          if (!grouped[s.scheduleDate]) grouped[s.scheduleDate] = [];
          grouped[s.scheduleDate].push({
            id: s.id,
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
        this.weeksCache[from] = grouped;
        this.applyWeekData();
      })
      .catch((e) => {
        this.weeksCache[from] = {};
        this.setData({ loading: false });
        toast(this, e.message);
      });
  },

  applyWeekData() {
    const grouped = this.weeksCache[dateKey(this.weekMonday)] || {};
    const booked = this.bookedIds || new Set();
    // 标记不写进 weeksCache —— 缓存的是课表本身，预约状态每次重算
    const weekDays = this.data.weekDays.map((d) => {
      const list = grouped[d.key] || [];
      return {
        ...d,
        hasClass: list.length > 0,
        bookedCount: list.filter((i) => booked.has(i.id)).length,
      };
    });
    const selectedKey = this.data.selectedKey || todayKey();
    const dayItems = (grouped[selectedKey] || []).map((i) => ({
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
    const grouped = this.weeksCache[dateKey(this.weekMonday)] || {};
    const booked = this.bookedIds || new Set();
    const dayItems = (grouped[key] || []).map((i) => ({ ...i, booked: booked.has(i.id) }));
    this.setData({
      selectedKey: key,
      selectedTitle: this.dayTitle(key),
      dayItems,
      bookedCount: dayItems.filter((i) => i.booked).length,
    });
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
