const app = getApp();
const api = require("../../services/api");
const jump = require("../../services/jump");
const { PLATFORM_LABEL, DIFF_LABEL } = require("../../utils/constants");
const { requestSubscribe } = require("../../utils/subscribe");
const { parseKey } = require("../../utils/date");

const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const LV_LABEL = {
  BEGINNER: "LV1",
  INTERMEDIATE: "LV3",
  ADVANCED: "LV5",
  ALL_LEVELS: "LV?",
};
const VIDEO_PLATFORMS = ["INSTAGRAM", "YOUTUBE", "NAVER"];

function format12h(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ":" + String(m).padStart(2, "0") + ampm;
}

Page({
  data: {
    scheduleId: null,
    detail: null,
    coachName: "",
    coachInitial: "",
    diffClass: "all_levels",
    levelLabel: "",
    diffLabel: "",
    timeLabel: "",
    dateLabel: "",
    platformLabel: "",
    bookingStatus: null,
    reminded: false,
    bookedCount: 0,
    capacity: 1,
    progress: 0,
    showVideo: false,
    videos: [],
    busy: false,
  },

  onLoad(query) {
    this.scheduleId = Number(query.id);
    this.setData({ scheduleId: this.scheduleId });
    this.load();
  },

  async load() {
    await api.ensureReady();
    try {
      const [d, video] = await Promise.all([
        api.apiScheduleDetail(this.scheduleId),
        api.apiScheduleVideoPreview(this.scheduleId),
      ]);
      const capacity = d.capacity || 1;
      const progress = Math.min(
        100,
        Math.round((d.bookedCount / capacity) * 100),
      );
      const coachName = d.coach ? d.coach.name : "待定";
      const coachInitial = d.coach && d.coach.name ? d.coach.name.charAt(0) : "?";
      const showVideo = VIDEO_PLATFORMS.indexOf(d.studio.platform) >= 0;
      this.setData({
        detail: d,
        coachName,
        coachInitial,
        diffClass: (d.difficulty || "ALL_LEVELS").toLowerCase(),
        levelLabel: LV_LABEL[d.difficulty] || "LV?",
        diffLabel: DIFF_LABEL[d.difficulty] || d.difficulty,
        timeLabel: format12h(d.startTime) + " - " + format12h(d.endTime),
        dateLabel: this.dayLabel(d.scheduleDate),
        platformLabel: PLATFORM_LABEL[d.studio.platform] || d.studio.platform,
        bookingStatus: d.bookingStatus,
        reminded: d.reminded,
        bookedCount: d.bookedCount,
        capacity,
        progress,
        showVideo,
        videos: showVideo ? video.items || [] : [],
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  dayLabel(key) {
    const d = parseKey(key);
    return d.getMonth() + 1 + "月" + d.getDate() + "日 · " + WEEK_CN[d.getDay()];
  },

  async goBook() {
    const d = this.data.detail;
    if (!d || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await api.apiCreateBooking(d.id, "JUMP");
      jump.jumpToPlatform(d.studio, {
        bookingUrl: d.bookingUrl,
        courseName: d.courseName,
        startTime: d.startTime,
      });
      this.setData({ busy: false });
      this.load();
    } catch (e) {
      this.setData({ busy: false });
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  async markBooked() {
    const d = this.data.detail;
    if (!d || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await api.apiCreateBooking(d.id, "MANUAL");
      this.setData({ busy: false });
      wx.showToast({ title: "已标记预约", icon: "success" });
      this.load();
    } catch (e) {
      this.setData({ busy: false });
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  async toggleRemind() {
    const d = this.data.detail;
    if (!d || this.data.busy) return;
    this.setData({ busy: true });
    try {
      if (this.data.reminded) {
        await api.apiRemoveReminder(d.id);
      } else {
        const tplId = app.globalData.classReminderTplId;
        const granted = tplId ? await requestSubscribe(tplId) : false;
        await api.apiAddReminder(d.id, granted);
      }
      const reminded = !this.data.reminded;
      this.setData({ reminded, busy: false });
      wx.showToast({ title: reminded ? "已开启开课提醒" : "已关闭提醒", icon: "none" });
      this.load();
    } catch (e) {
      this.setData({ busy: false });
      wx.showToast({ title: e.message, icon: "none" });
    }
  },

  openVideo(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.navigateTo({
      url: "/pages/webview/webview?url=" + encodeURIComponent(url),
    });
  },
});
