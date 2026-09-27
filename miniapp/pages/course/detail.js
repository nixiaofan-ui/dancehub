const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");
const jump = require("../../services/jump");
const { PLATFORM_LABEL, DIFF_LABEL } = require("../../utils/constants");
const { requestSubscribe } = require("../../utils/subscribe");
const { confirm } = require("../../utils/confirm");
const { bookCourse } = require("../../utils/booking");
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
      // 预约按钮文案：海外官网店复制网址，其余一律复制店名去微信搜索
      // （不再做小程序互跳：app.json 跳转名单上限 10 个，库里有 100 个不同 appId，
      //  且批量跳转第三方小程序属平台禁止的「小程序盒子」形态）
      const bookLabel = d.studio.officialUrl
        ? "复制官网地址去预约"
        : "复制店名去微信预约";
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
        bookLabel,
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
      const res = await bookCourse(d.id, "JUMP", d);
      if (!res) {
        this.setData({ busy: false }); // 撞课，用户放弃：记得解锁按钮
        return;
      }
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
      const res = await bookCourse(d.id, "MANUAL", d);
      this.setData({ busy: false });
      if (!res) return; // 撞课，用户放弃
      toast(this, "已标记预约", "success");
      this.load();
    } catch (e) {
      this.setData({ busy: false });
      toast(this, e.message);
    }
  },

  async cancelBooking() {
    const d = this.data.detail;
    if (!d || this.data.busy) return;
    const yes = await confirm({
      title: "取消预约",
      content: `确定取消「${d.courseName || "这节课"}」的预约吗？`,
      confirmText: "取消预约",
    });
    if (!yes) return;
    this.setData({ busy: true });
    try {
      const res = await api.apiCancelBooking(d.id);
      this.setData({ busy: false });
      toast(
        this,
        res && res.reminderRemoved ? "已取消预约，开课提醒也关掉了" : "已取消预约",
        "success",
      );
      // 重拉详情：预约状态和提醒开关都在这一份数据里，取消后要一起刷新
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
    let opening = "已开启开课提醒";
    try {
      if (this.data.reminded) {
        await api.apiRemoveReminder(d.id);
      } else {
        const tplId = app.globalData.classReminderTplId;
        const granted = tplId ? await requestSubscribe(tplId) : false;
        await api.apiAddReminder(d.id, granted);
        // 说真话：没拿到授权就只是本地提醒，收不到微信推送
        opening = granted
          ? "已开启订阅提醒"
          : tplId
            ? "仅本地提醒（未授权推送）"
            : "仅本地提醒（订阅模板未配置）";
      }
      const reminded = !this.data.reminded;
      this.setData({ reminded, busy: false });
      toast(this, reminded ? opening || "已开启开课提醒" : "已关闭提醒");
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
