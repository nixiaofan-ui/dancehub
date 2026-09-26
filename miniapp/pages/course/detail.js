const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");
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

function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":");
  return h + ":" + m;
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
    roomName: "",
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
      // 海外舞室楼层/教室信息存于 remark（格式「抓取状态：xx | 场地：1F」），
      // 解析出「场地：」之后的值单独展示，不暴露内部抓取状态
      let roomName = "";
      if (d.remark) {
        const m = d.remark.match(/场地：([^|]+)/);
        if (m) roomName = m[1].trim();
      }
      this.setData({
        detail: d,
        coachName,
        coachInitial,
        diffClass: (d.difficulty || "ALL_LEVELS").toLowerCase(),
        levelLabel: LV_LABEL[d.difficulty] || "LV?",
        diffLabel: DIFF_LABEL[d.difficulty] || d.difficulty,
        timeLabel: formatTime(d.startTime) + " - " + formatTime(d.endTime),
        dateLabel: this.dayLabel(d.scheduleDate),
        roomName,
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
      toast(this, e.message);
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
      toast(this, e.message);
    }
  },

  async markBooked() {
    const d = this.data.detail;
    if (!d || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await api.apiCreateBooking(d.id, "MANUAL");
      this.setData({ busy: false });
      toast(this, "已标记预约", "success");
      this.load();
    } catch (e) {
      this.setData({ busy: false });
      toast(this, e.message);
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
      toast(this, reminded ? "已开启开课提醒" : "已关闭提醒");
      this.load();
    } catch (e) {
      this.setData({ busy: false });
      toast(this, e.message);
    }
  },

  openVideo(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.navigateTo({
      url: "/pages/webview/webview?url=" + encodeURIComponent(url),
    });
  },

  previewCover(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.previewImage({ urls: [url] });
  },
});
