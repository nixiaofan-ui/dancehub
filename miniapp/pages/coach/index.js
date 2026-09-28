const app = getApp();
const api = require("../../services/api");
const { DIFF_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");
const { dateKey, addDays, todayKey, parseKey } = require("../../utils/date");
const { isBlocked, block, unblock } = require("../../utils/blocked");
const { isFav, fav, unfav } = require("../../utils/fav-coaches");
const { onNavTop } = require("../../utils/scroll-top");

const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dayLabel(key) {
  const d = parseKey(key);
  const today = todayKey();
  let head = d.getMonth() + 1 + "月" + d.getDate() + "日 " + WEEK_CN[d.getDay()];
  if (key === today) head = "今天 " + head;
  else if (key === addDays(today, 1)) head = "明天 " + head;
  return head;
}

Page({
  onNavTop,

  data: {
    name: "",
    cityId: null,
    loading: true,
    studios: [],
    days: [],
    total: 0,
    blocked: false,
    fav: false,
  },

  onLoad(query) {
    this.name = decodeURIComponent(query.name || "");
    this.cityId = Number(query.cityId);
    this.setData({
      name: this.name,
      cityId: this.cityId,
      blocked: isBlocked(this.name),
      loading: true,
    });
    this.load();
  },

  /**
   * 每次显示都重读一次本地名单：可能在「我的」页刚取消过关注，
   * 也可能云端同步回来了一批新名字。
   */
  onShow() {
    if (!this.name) return;
    this.setData({
      fav: isFav(this.name),
      blocked: isBlocked(this.name),
    });
    api
      .ensureReady()
      .then(() => Promise.all([api.apiFavCoaches(), api.apiBlocked()]))
      .then(([favs, blocks]) => {
        this.setData({
          fav: (favs || []).indexOf(this.name) >= 0 || isFav(this.name),
          blocked: blocks ? blocks.indexOf(this.name) >= 0 : this.data.blocked,
        });
      })
      .catch(() => {});
  },

  async load() {
    await api.ensureReady();
    try {
      const res = await api.apiCoachTimeline(this.name, this.cityId, 14);
      // 课程已按 日期→时间 排好，这里只需切成「天」的小节
      const bucket = new Map();
      (res.items || []).forEach((s) => {
        if (!bucket.has(s.scheduleDate)) bucket.set(s.scheduleDate, []);
        bucket.get(s.scheduleDate).push({
          id: s.id,
          courseName: s.courseName,
          coachName: s.coach ? s.coach.name : this.name,
          startTime: s.startTime,
          endTime: s.endTime,
          timeLabel: s.startTime + " - " + s.endTime,
          studioShort: s.studio.short || s.studio.name,
          diffLabel: DIFF_LABEL[s.difficulty] || s.difficulty,
          diffClass: (s.difficulty || "ALL_LEVELS").toLowerCase(),
          booked: !!s.bookingStatus,
          bookingStatus: s.bookingStatus || null,
        });
      });
      const days = [...bucket.entries()].map(([key, list]) => ({
        key,
        label: dayLabel(key),
        items: list,
      }));
      this.setData({
        days,
        studios: res.studios || [],
        total: (res.items || []).length,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      toast(this, e.message);
    }
  },

  goCourse(e) {
    wx.navigateTo({ url: "/pages/course/detail?id=" + e.currentTarget.dataset.id });
  },

  goStudio(e) {
    wx.navigateTo({ url: "/pages/studio/weekly?id=" + e.currentTarget.dataset.id });
  },

  /**
   * 屏蔽 / 取消屏蔽。
   * 本地先改：列表应立即有反馈，不能让用户等网络往返。
   */
  async toggleBlock() {
    const name = this.data.name;
    const next = !this.data.blocked;
    this.setData({ blocked: next });
    if (next) block(name);
    else unblock(name);
    try {
      if (next) await api.apiBlock(name);
      else await api.apiUnblock(name);
    } catch (e) {
      // 云端失败不影响本地 —— 只是换手机后会丢，不该因此回滚用户当前的操作
      console.error("[dancehub] 屏蔽同步失败:", e);
    }
    toast(this, next ? `不再显示「${name}」的课` : `已恢复「${name}」的课`, "success");
  },

  /** 标记 / 取消「常看」（爱师）。同样是本地先改、云端兜底同步。 */
  async toggleFav() {
    const name = this.data.name;
    if (!name) return;
    const next = !this.data.fav;
    this.setData({ fav: next });
    if (next) fav(name);
    else unfav(name);
    try {
      if (next) await api.apiFavCoach(name);
      else await api.apiUnfavCoach(name);
    } catch (e) {
      console.error("[dancehub] 常看老师同步失败:", e);
    }
    toast(this, next ? `已把「${name}」设为常看` : `已移出常看`, "success");
  },
});
