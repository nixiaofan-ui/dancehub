const app = getApp();
const api = require("../../services/api");
const { dateKey, addDays, todayKey } = require("../../utils/date");
const { toast } = require("../../utils/toast");

const DIFF_OPTIONS = ["不限", "入门", "进阶", "高阶"];
const DIFF_VALUE = {
  不限: "ALL_LEVELS",
  入门: "BEGINNER",
  进阶: "INTERMEDIATE",
  高阶: "ADVANCED",
};

/**
 * 结构化逐条录入。
 *
 * 为什么不做「粘贴文本自动解析」：各家公众号课表排版五花八门，
 * 解析错一条不会报错、也不会有人发现，用户只会觉得「这软件数据不准」。
 * 手工录入慢几秒，换来的是数据可信。
 *
 * 主要用途是补那些没用 SaaS、我们抓不到的独立舞室
 * —— 门店名自由输入，库里没有就顺手建出来。
 */
Page({
  data: {
    // 未来 14 天可选，避免录进历史日期
    dates: [],
    dateIndex: 0,
    dateText: "",
    starts: [],
    startIndex: -1,
    startText: "",
    ends: [],
    endIndex: -1,
    endText: "",
    diffIndex: 0,
    diffs: DIFF_OPTIONS,

    studioName: "",
    courseName: "",
    coachName: "",
    submitBusy: false,
    lastResult: null,
  },

  onLoad() {
    const dates = [];
    for (let i = 0; i < 14; i++) {
      const k = addDays(todayKey(), i);
      dates.push(k);
    }
    const starts = [];
    for (let h = 9; h <= 22; h++) {
      starts.push(String(h).padStart(2, "0") + ":00");
      starts.push(String(h).padStart(2, "0") + ":30");
    }
    const ends = starts.slice();

    this.setData({
      dates: dates,
      dateText: dates[0],
      starts: starts,
      ends: ends,
    });
  },

  onStudio(e) {
    this.setData({ studioName: e.detail.value });
  },
  onCourse(e) {
    this.setData({ courseName: e.detail.value });
  },
  onCoach(e) {
    this.setData({ coachName: e.detail.value });
  },

  onDate(e) {
    const i = Number(e.detail.value);
    this.setData({ dateIndex: i, dateText: this.data.dates[i] });
  },
  onStart(e) {
    const i = Number(e.detail.value);
    this.setData({ startIndex: i, startText: this.data.starts[i] });
  },
  onEnd(e) {
    const i = Number(e.detail.value);
    this.setData({ endIndex: i, endText: this.data.ends[i] });
  },
  onDiff(e) {
    this.setData({ diffIndex: Number(e.detail.value) });
  },

  async submit() {
    const s = this.data;
    if (!s.studioName.trim()) return toast(this, "先填门店名");
    if (!s.courseName.trim()) return toast(this, "先填课程名");
    if (s.startIndex < 0) return toast(this, "选一下开始时间");
    if (s.submitBusy) return;

    this.setData({ submitBusy: true });
    try {
      await api.ensureReady();
      const res = await api.apiImportSchedule({
        studioName: s.studioName.trim(),
        cityId: app.globalData.cityId,
        date: s.dateText,
        startTime: s.startText,
        endTime: s.endIndex >= 0 ? s.endText : addMinutes(s.startText, 90),
        courseName: s.courseName.trim(),
        coachName: s.coachName.trim(),
        difficulty: DIFF_VALUE[s.diffs[s.diffIndex]],
      });

      toast(this, res.message || "已录入", "success");
      this.setData({
        lastResult: {
          studio: s.studioName.trim(),
          date: s.dateText,
          time: s.startText,
          course: s.courseName.trim(),
        },
        // 清掉这一节的课名教练，方便连着录同一家店的下一节
        courseName: "",
        coachName: "",
        submitBusy: false,
      });
    } catch (e) {
      toast(this, e.message);
      this.setData({ submitBusy: false });
    }
  },

  goReport() {
    wx.navigateTo({ url: "/pages/report/index" });
  },
});

/** 没选结束时间就按 90 分钟一节（多数舞室的单课时长） */
function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + mins;
  const hh = String(Math.min(23, Math.floor(total / 60))).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return hh + ":" + mm;
}
