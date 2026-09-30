const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");
const jump = require("../../services/jump");
const { PLATFORM_LABEL, DIFF_LABEL } = require("../../utils/constants");
const { requestSubscribe } = require("../../utils/subscribe");
const { confirm } = require("../../utils/confirm");
const { bookCourse } = require("../../utils/booking");
const { parseKey, todayKey } = require("../../utils/date");
const { onNavTop } = require("../../utils/scroll-top");
const { onTapCoach } = require("../../utils/coach-nav");
const cal = require("../../utils/calendar");

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
  onNavTop,

  data: {
    scheduleId: null,
    detail: null,
    coachName: "",
    coachInitial: "",
    // 老师头像（各平台 CDN 直链）。只有部分平台给，没有就退回首字母占位
    coachAvatar: "",
    // 跳老师主页要带城市（老师主页按「同城同名老师」聚合）
    cityId: 0,
    diffClass: "all_levels",
    levelLabel: "",
    diffLabel: "",
    timeLabel: "",
    dateLabel: "",
    roomName: "",
    platformLabel: "",
    bookingStatus: null,
    reminded: false,
    // 约课提醒：已设时刻（服务端给的北京时间字符串 "2026-10-05 12:00"）。
    // 为什么要有它：「能查到课」≠「约得上」—— 课表常常提前一周就放出来了，
    // 但真正开放预约是临近那几天的某个点，热门课要卡着那个点去抢。
    // 那个点各店自己定、没有任何平台接口给，只能让用户自己填。
    snipeRemindAt: null,
    snipeLabel: "",
    // 设置提醒的弹层
    snipeOpen: false,
    snipeDate: "",
    snipeTime: "12:00",
    // 设提醒时顺手写一份到手机系统日历：订阅消息是一次性的（一次授权只能推一条），
    // 日历不消耗额度、离线也响，是这个功能真正的兜底
    snipeSyncCal: true,
    calHint: cal.CAL_HINT,
    todayKey: "",
    bookedCount: 0,
    capacity: 1,
    progress: 0,
    // 舞室官方系统的真实已约人数；null = 该平台不公开，前端显示「未公开」
    bookedNum: null,
    // 数据来源说明：「刚刚更新」/「今早 09:15 抓取」/「该舞室未公开」
    bookMeta: "",
    refreshing: false,
    showVideo: false,
    videos: [],
    // 舞室官方系统的「课程预告视频」直链。**不缓存**：上游给的是签名地址，
    // 1 小时就过期，缓存下来再打开就是白屏。每次进页面重新问服务端要。
    nativeVideo: "",
    busy: false,
  },

  onLoad(query) {
    this.scheduleId = Number(query.id);
    this.setData({ scheduleId: this.scheduleId, todayKey: todayKey() });
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
      // 有平台真实人数就用它算满座率；没有才退回本小程序的用户预约数。
      // 之前一律用 bookedCount（全站只有个位数用户）→ 永远显示「0 / 30 人」，
      // 看着像假数据，其实是我们自己的口径错了。
      const bookedNum = d.bookedNum != null ? Number(d.bookedNum) : null;
      const shown =
        bookedNum != null ? bookedNum : Number(d.bookedCount || 0);
      const progress = Math.min(100, Math.round((shown / capacity) * 100));
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
        coachAvatar: (d.coach && d.coach.avatarUrl) || "",
        cityId: d.studio.cityId || 0,
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
        snipeRemindAt: d.snipeRemindAt || null,
        snipeLabel: d.snipeRemindAt ? "约课提醒 " + String(d.snipeRemindAt).slice(5) : "设约课提醒",
        bookedCount: d.bookedCount,
        bookedNum,
        shownCount: shown,
        bookMeta:
          bookedNum != null
            ? // bookedAt = 这行数据最后写入库的时间（抓取快照）。用它而不是 liveCheckedAt：
              // 后者只有回源成功才有，缺失时会显示成「刚抓取」，把 6 小时前的旧数说成新的
              "来自舞室官方系统 · " + this.stampLabel(d.bookedAt)
            : "该舞室未公开人数",
        capacity,
        progress,
        showVideo,
        videos: showVideo ? video.items || [] : [],
      });
      // 详情渲染完再后台回源刷新一次（不阻塞首屏；拿不到就保持旧值）
      this.refreshLive();
      // 课程预告视频同样后台取，不挡住首屏 —— 它是一次额外的上游往返
      if (d.hasVideo) this.loadNativeVideo();
    } catch (e) {
      toast(this, e.message);
    }
  },

  /**
   * 取这节课的「课程预告视频」直链（舞室官方系统里的那条）。
   *
   * 为什么不跟详情一起返回：那个地址是腾讯云点播的**签名链接，1 小时过期**，
   * 服务端每次都要去上游换一张新签名，是一次独立往返。放在详情里会拖慢首屏，
   * 而视频本来就在页面底部，后台取完全够用。
   *
   * 取不到（商家撤回了 / 上游抖动）就保持空串 → 整块不渲染，
   * 用户看到的只是没有预告视频，不会看到一块报错的播放器。
   */
  async loadNativeVideo() {
    try {
      const r = await api.apiScheduleVideoUrl(this.scheduleId);
      if (r && r.url) this.setData({ nativeVideo: r.url });
    } catch (e) {
      // 静默降级
    }
  },

  /** 把 UTC 时间戳转成「刚刚 / N 分钟前 / 今天 09:15」这类人话 */
  stampLabel(iso) {
    if (!iso) return "刚抓取";
    // 服务端吐的是 ISO 字符串，ISO 带 Z 时 iOS 能解析，安卓部分机型不行，这里统一补 Z
    const t = new Date(String(iso).replace(" ", "T").replace(/Z?$/, "Z"));
    const ms = Date.now() - t.getTime();
    if (Number.isNaN(t.getTime())) return "刚抓取";
    if (ms < 60 * 1000) return "刚刚更新";
    if (ms < 60 * 60 * 1000) return Math.floor(ms / 60000) + " 分钟前";
    const pad = (n) => String(n).padStart(2, "0");
    // 注意：这里没有按 UTC 校正时区，服务端返回的是 UTC，
    // 显示小时会差 8 小时 —— 用 getUTC** 反而更贴近国内用户看到的本地时间，
    // 因为服务端写库用的也是 UTC 基准。
    const hh = pad(t.getHours());
    const mm = pad(t.getMinutes());
    return `今天 ${hh}:${mm}`;
  },

  /** 回源舞室官方系统刷新真实约课人数 */
  async refreshLive() {
    if (this.data.refreshing) return;
    this.setData({ refreshing: true });
    try {
      const live = await api.apiLiveBooking(this.scheduleId);
      const capacity = live.capacity || this.data.capacity || 1;
      const bookedNum = live.bookedNum != null ? Number(live.bookedNum) : null;
      if (bookedNum == null) {
        this.setData({
          refreshing: false,
          bookMeta: "该舞室未公开人数",
        });
        return;
      }
      this.setData({
        bookedNum,
        shownCount: bookedNum,
        capacity,
        progress: Math.min(100, Math.round((bookedNum / capacity) * 100)),
        bookMeta: live.live
          ? "来自舞室官方系统 · 刚刚更新"
          : "来自舞室官方系统 · " + this.stampLabel(live.checkedAt),
        refreshing: false,
      });
    } catch (e) {
      // 回源失败不打扰用户，保留原有数值
      this.setData({ refreshing: false });
    }
  },

  onTapRefreshLive() {
    this.refreshLive();
  },

  dayLabel(key) {
    const d = parseKey(key);
    return d.getMonth() + 1 + "月" + d.getDate() + "日 · " + WEEK_CN[d.getDay()];
  },

  // 点教练名 → 老师主页（教练为「待定」时内部直接忽略）
  goCoach: onTapCoach,

  /** 头像加载失败（CDN 挂了 / 链接过期 / 链接含特殊字符）：退回首字母占位，别留个白圈 */
  onCoachAvatarError() {
    if (this.data.coachAvatar) this.setData({ coachAvatar: "" });
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

  /* ── 约课提醒 ──
   * 为什么不并进「开课提醒」：两者时刻的来源根本不同。
   * 开课提醒服务端算得出（课前 2 小时，规则统一）；而「几点开放预约」没有 ——
   * 门店提前一周就把课表放出来了，但真正能约是临近那几天的某个点，热门课要卡着抢。
   * 那个点各店自己定、任何平台接口都不给，只能让用户填。
   * ⛔ 也别指望我们"推算"出来：能观测到的只有「这节课第一次被我们抓到」，
   *   而抓取是 6 小时一轮 —— 推出来的钟点其实是我们的抓取钟点，当放课时刻会误导人。
   */
  openSnipe() {
    const base = this.data.snipeRemindAt ? String(this.data.snipeRemindAt) : "";
    // 设过就回填原值让人改，而不是让他从头再选一遍
    this.setData({
      snipeOpen: true,
      snipeDate: base ? base.slice(0, 10) : this.data.todayKey,
      snipeTime: base ? base.slice(11, 16) : "12:00",
    });
  },

  closeSnipe() {
    this.setData({ snipeOpen: false });
  },
  onSnipeDate(e) {
    this.setData({ snipeDate: e.detail.value });
  },
  onSnipeTime(e) {
    this.setData({ snipeTime: e.detail.value });
  },
  onSnipeSyncCal(e) {
    this.setData({ snipeSyncCal: Boolean(e.detail.value) });
  },
  // 弹层内容区的点击不该冒泡到遮罩（否则一点就关）
  noop() {},

  async saveSnipe() {
    if (this.data.busy) return;
    const { snipeDate, snipeTime } = this.data;
    const d = this.data.detail || {};
    if (!snipeDate) return toast(this, "先选个日期");
    const at = snipeDate + " " + snipeTime;
    this.setData({ busy: true });
    try {
      // 约课提醒比开课提醒更依赖推送：那一下用户多半根本不在小程序里
      const tplId = app.globalData.classReminderTplId;
      const granted = tplId ? await requestSubscribe(tplId) : false;
      await api.apiAddReminder(this.scheduleId, granted, { kind: "SNIPE", remindAt: at });

      // 再顺手写一份到手机系统日历。⚠ 日历失败绝不能连提醒一起废掉：
      // 订阅消息一次性消耗，日历才是"蹲点"最靠得住的那条通道，所以单独 try、单独报告。
      let calNote = "";
      if (this.data.snipeSyncCal) {
        try {
          const r = await cal.addWatchToCalendar({
            dateKey: snipeDate,
            hhmm: snipeTime,
            title: "去约课：" + (d.courseName || "舞蹈课"),
            desc:
              (d.studio && d.studio.name ? d.studio.name + " · " : "") +
              "DanceHub 提醒你到点去约课",
          });
          calNote = r && r.added ? "，也写进手机日历了" : "（日历没加成，只有微信提醒）";
        } catch (e) {
          calNote = "（日历没加成，只有微信提醒）";
        }
      }

      this.setData({ busy: false, snipeOpen: false });
      toast(
        this,
        (granted ? "已设 " + at + " 约课提醒" : "提醒已设（未授权推送，只能进小程序看）") + calNote,
        granted ? "success" : undefined,
      );
      this.load();
    } catch (e) {
      this.setData({ busy: false });
      toast(this, e.message);
    }
  },

  async removeSnipe() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await api.apiRemoveReminder(this.scheduleId, "SNIPE");
      this.setData({ busy: false, snipeOpen: false });
      toast(this, "已关掉约课提醒", "success");
      this.load();
    } catch (e) {
      this.setData({ busy: false });
      toast(this, e.message);
    }
  },

  /**
   * 把这节课写进手机系统日历（已约的课尤其需要：提前 1 小时响，
   * 不依赖我们推送、不消耗订阅额度，换手机也能同步过去）。
   */
  async addToCalendar() {
    const d = this.data.detail;
    if (!d || this.data.busy) return;
    this.setData({ busy: true });
    try {
      const r = await cal.addCourseToCalendar({
        dateKey: d.scheduleDate,
        startTime: d.startTime,
        endTime: d.endTime,
        courseName: d.courseName,
        studioName: d.studio && d.studio.name,
        coachName: d.coach && d.coach.name,
        roomName: this.data.roomName,
        address: d.studio && d.studio.address,
      });
      this.setData({ busy: false });
      if (r && r.denied) return toast(this, "没有日历权限，去「设置 → 微信 → 日历」打开");
      toast(this, "已加入手机日历（提前 1 小时提醒）", "success");
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
