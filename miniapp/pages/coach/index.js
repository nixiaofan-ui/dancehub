const app = getApp();
const api = require("../../services/api");
const { DIFF_LABEL } = require("../../utils/constants");
const { toast } = require("../../utils/toast");
const { dateKey, addDays, todayKey, parseKey } = require("../../utils/date");
const { isBlocked, block, unblock } = require("../../utils/blocked");
const { isFav, fav, unfav } = require("../../utils/fav-coaches");
const { onNavTop } = require("../../utils/scroll-top");
// URL 里没带 cityId 时（比如旧链接、外部跳转），退回当前城市，别拿 NaN 去查
const { resolveCityId } = require("../../utils/coach-nav");

const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * ⚠ 这里踩过一次：`addDays` 收的是 **Date**，而 `todayKey()` 返回的是字符串
 * （"2026-09-30"）。写成 `addDays(today, 1)` 直接抛 `d.getTime is not a function`
 * —— 而它是在 load() 里给未来课分组时调的，一抛就把整个 load 打断：
 * 「上周排课规律」和「接下来能约」两块同时变空，用户以为这位老师一条课都没有。
 * 要字符串就老实绕一圈 dateKey(parseKey(...))。
 */
function dayLabel(key) {
  const d = parseKey(key);
  const today = todayKey();
  const tomorrow = dateKey(addDays(parseKey(today), 1));
  let head = d.getMonth() + 1 + "月" + d.getDate() + "日 " + WEEK_CN[d.getDay()];
  if (key === today) head = "今天 " + head;
  else if (key === tomorrow) head = "明天 " + head;
  return head;
}

/** 2026-10-04 → 10-04。门店条上只放得下这么长 */
function mdOf(key) {
  return key ? String(key).slice(5) : "";
}

Page({
  onNavTop,

  data: {
    name: "",
    cityId: null,
    loading: true,
    // 接口挂了不要只留白：错误文案 + 重试按钮（空白页会被读成「这老师没课」）
    loadError: "",
    // 任教门店条：[{ id, short, badge:「今天有课」/「10-04 有课」/「上周 2 节」, hot }]
    studios: [],
    // 过去一周按「周几」归并的排课规律（主视图）
    weekdays: [],
    pastTotal: 0,
    // 未来可约的课（多数老师为空，空则提示）
    days: [],
    total: 0,
    blocked: false,
    fav: false,
  },

  onLoad(query) {
    this.name = decodeURIComponent(query.name || "");
    this.cityId = resolveCityId(query.cityId);
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

  /**
   * 老师主页 = 「上周排课规律」+「未来可约」。
   *
   * 为什么主视图改成过去一周：绝大多数舞室只在小程序里放最近几天甚至当天的课，
   * 「未来两周 N 节课」常年是 0，看着像数据没抓到。而库里保留了历史课，
   * 用「他上周固定周几在哪家店、几点、上什么」来描述这位老师，
   * 才是用户真能拿去安排时间的信（`2026-09-28` 改）。
   */
  async load() {
    this.setData({ loading: true, loadError: "" });
    try {
      // ⚠ ensureReady 必须在 try 里面。它等的是 app.ready 的登录结果，
      // 放在 try 外面一旦 reject，load 直接中断、loading 永远停在 true ——
      // 用户看到的就是「正在整理这位老师的课…」转到天荒地老，两块内容都不出来。
      await api.ensureReady();
      const [past, future] = await Promise.all([
        api.apiCoachTimeline(this.name, this.cityId, 7, "past"),
        api.apiCoachTimeline(this.name, this.cityId, 14),
      ]);

      const decorate = (s) => ({
        id: s.id,
        courseName: s.courseName,
        coachName: s.coach ? s.coach.name : this.name,
        startTime: s.startTime,
        endTime: s.endTime,
        timeLabel: s.startTime + " - " + s.endTime,
        studioShort: s.studio.short || s.studio.name,
        studioId: s.studio.id,
        diffLabel: DIFF_LABEL[s.difficulty] || s.difficulty,
        diffClass: (s.difficulty || "ALL_LEVELS").toLowerCase(),
        booked: !!s.bookingStatus,
        bookingStatus: s.bookingStatus || null,
      });

      // ── 过去一周：按「周几」归并，看出这位老师的固定档期 ──
      const weekdayMap = new Map();
      (past.items || []).forEach((s) => {
        const d = parseKey(s.scheduleDate);
        const wd = d.getDay(); // 0=周日
        if (!weekdayMap.has(wd)) weekdayMap.set(wd, []);
        weekdayMap.get(wd).push(decorate(s));
      });
      const weekdays = [...weekdayMap.entries()]
        .sort((a, b) => (a[0] === 0 ? 7 : a[0]) - (b[0] === 0 ? 7 : b[0]))
        .map(([wd, list]) => ({
          // ⚠ WEEK_CN 里存的已经是「周二」，别再拼「周」——曾渲染成「周周二」（2026-09-29）
          weekday: WEEK_CN[wd],
          count: list.length,
          items: list.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime))),
        }));

      // ── 未来：能约的课按日期分小节（多数老师这里是空的，空就提示）──
      const bucket = new Map();
      (future.items || []).forEach((s) => {
        if (!bucket.has(s.scheduleDate)) bucket.set(s.scheduleDate, []);
        bucket.get(s.scheduleDate).push(decorate(s));
      });
      const days = [...bucket.entries()].map(([key, list]) => ({
        key,
        label: dayLabel(key),
        items: list,
      }));

      // ── 门店条：哪家店、下次什么时候有课 ──
      // 这块信息原来是挤在发现页的教练卡片上的（「陆家嘴店 · 09-30 有课」），
      // 卡片一行塞不下几个字，挪到这里之后卡片只留店名，时间由这张页承载。
      // 未来有课的排前面（这是「能不能去上」的答案），只在过去一周出现过的补在后。
      const bar = new Map();
      (future.studios || []).forEach((s) => {
        bar.set(s.id, {
          id: s.id,
          short: s.short,
          badge: s.today ? "今天有课" : mdOf(s.firstDate) + " 有课",
          hot: !!s.today,
          firstDate: s.firstDate || "",
          pastCount: 0,
        });
      });
      (past.studios || []).forEach((s) => {
        const cur = bar.get(s.id);
        if (cur) {
          cur.pastCount = s.count;
          return;
        }
        bar.set(s.id, {
          id: s.id,
          short: s.short,
          badge: "上周 " + s.count + " 节",
          hot: false,
          firstDate: "",
          pastCount: s.count,
        });
      });
      // 有未来课的排前面（「能不能去上」才是用户找这里的理由），
      // 同样有课比日期先后；只有历史的按课量排。日期串直接比大小，
      // 不用 localeCompare —— 小程序 JSCore 与 Node 的排序规则未必一致。
      const studios = [...bar.values()].sort((a, b) => {
        if (!!a.firstDate !== !!b.firstDate) return a.firstDate ? -1 : 1;
        if (a.firstDate && b.firstDate && a.firstDate !== b.firstDate) {
          return a.firstDate < b.firstDate ? -1 : 1;
        }
        return b.pastCount - a.pastCount;
      });

      this.setData({
        weekdays,
        days,
        studios,
        pastTotal: (past.items || []).length,
        total: (future.items || []).length,
        loading: false,
        loadError: "",
      });
    } catch (e) {
      // 只弹 toast 的话，页面会是一片空白 + 一闪而过的提示，用户只会以为
      // 「这位老师没课」。错误留在页面上，配上重试按钮。
      this.setData({ loading: false, loadError: e.message || "加载失败", weekdays: [], days: [] });
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
   *
   * ⚠ 与「常看」互斥：一个要往前排、一个要藏起来，同时开着等于没设
   * （foldBlocked 优先于 fav 置顶，实际表现就是屏蔽赢）。所以这里开一个
   * 会自动解另一个，与「我的 · 我的老师」那一栏的行为保持一致。
   */
  async toggleBlock() {
    const name = this.data.name;
    const next = !this.data.blocked;
    const droppedFav = next && this.data.fav;
    this.setData({ blocked: next, fav: droppedFav ? false : this.data.fav });
    if (next) {
      block(name);
      if (droppedFav) unfav(name);
    } else {
      unblock(name);
    }
    try {
      if (next) {
        await api.apiBlock(name);
        if (droppedFav) await api.apiUnfavCoach(name);
      } else {
        await api.apiUnblock(name);
      }
    } catch (e) {
      // 云端失败不影响本地 —— 只是换手机后会丢，不该因此回滚用户当前的操作
      console.error("[dancehub] 屏蔽同步失败:", e);
    }
    toast(
      this,
      next
        ? `不再显示「${name}」的课` + (droppedFav ? "，已移出常看" : "")
        : `已恢复「${name}」的课`,
      "success",
    );
  },

  /** 标记 / 取消「常看」（爱师）。同样是本地先改、云端兜底同步，同样与屏蔽互斥。 */
  async toggleFav() {
    const name = this.data.name;
    if (!name) return;
    const next = !this.data.fav;
    const unblocked = next && this.data.blocked;
    this.setData({ fav: next, blocked: unblocked ? false : this.data.blocked });
    if (next) {
      fav(name);
      if (unblocked) unblock(name);
    } else {
      unfav(name);
    }
    try {
      if (next) {
        await api.apiFavCoach(name);
        if (unblocked) await api.apiUnblock(name);
      } else {
        await api.apiUnfavCoach(name);
      }
    } catch (e) {
      console.error("[dancehub] 常看老师同步失败:", e);
    }
    toast(
      this,
      next
        ? `已把「${name}」设为常看` + (unblocked ? "，不再屏蔽" : "")
        : `已移出常看`,
      "success",
    );
  },
});
