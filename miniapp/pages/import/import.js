const app = getApp();
const api = require("../../services/api");
const { dateKey, addDays, todayKey } = require("../../utils/date");
const { toast } = require("../../utils/toast");
const { confirm } = require("../../utils/confirm");
const { onNavTop } = require("../../utils/scroll-top");

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
  onNavTop,

  data: {
    // 日期/时间一律走系统原生滚轮（mode="date" / mode="time"）。
    // 早先是 mode="selector" + 自建选项数组，真机上弹出来一片空白且划不动：
    // 开始/结束用 -1 当「未选择」的哨兵，value 越界后滚轮算不出初始位置就渲染空了。
    // 原生滚轮没这个坑，还能选到任意分钟，比 28 项的半小时列表更好用。
    dateText: "",
    dateStart: "",
    dateEnd: "", // 未来 14 天可选，避免录进历史日期
    startText: "19:00",
    endText: "", // 空 = 没选，提交时按 90 分钟补
    endAuto: "20:30",
    diffIndex: 0,
    diffs: DIFF_OPTIONS,

    studioName: "",
    courseName: "",
    coachName: "",
    submitBusy: false,
    lastResult: null,
    // 我录过的课（只有本人可见，所以列表也只列本人的）
    mine: [],
  },

  async onShow() {
    this.loadMine();
  },

  async loadMine() {
    try {
      await api.ensureReady();
      const rows = await api.apiMyImports();
      this.setData({ mine: rows || [] });
    } catch (e) {
      // 列表拉不到不影响录入，静默即可
      console.error("[import] 载入我录的课失败:", e.message);
    }
  },

  async delMine(e) {
    const id = Number(e.currentTarget.dataset.id);
    const okDel = await confirm({
      title: "删掉这节录入的课？",
      content: "删了就找不回来了",
      confirmText: "删除",
    });
    if (!okDel) return;
    try {
      await api.apiDeleteImport(id);
      this.setData({ mine: this.data.mine.filter((x) => x.id !== id) });
      toast(this, "已删除", "success");
    } catch (err) {
      toast(this, err.message);
    }
  },

  onLoad() {
    const today = todayKey();
    this.setData({
      dateText: today,
      dateStart: today,
      dateEnd: addDays(today, 13),
      endAuto: addMinutes(this.data.startText, 90),
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
    this.setData({ dateText: e.detail.value });
  },
  onStart(e) {
    const startText = e.detail.value;
    // 没手动选过结束时间就一直跟着开始时间走，省一次点击
    this.setData({
      startText,
      endAuto: addMinutes(startText, 90),
      endText: this.data.endText ? this.data.endText : "",
    });
  },
  onEnd(e) {
    this.setData({ endText: e.detail.value });
  },
  tapDiff(e) {
    this.setData({ diffIndex: Number(e.currentTarget.dataset.i) });
  },

  async submit() {
    const s = this.data;
    if (!s.studioName.trim()) return toast(this, "先填门店名");
    if (!s.courseName.trim()) return toast(this, "先填课程名");
    if (s.submitBusy) return;

    this.setData({ submitBusy: true });
    try {
      await api.ensureReady();
      const res = await api.apiImportSchedule({
        studioName: s.studioName.trim(),
        cityId: app.globalData.cityId,
        date: s.dateText,
        startTime: s.startText,
        endTime: s.endText || s.endAuto,
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
      this.loadMine();
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
