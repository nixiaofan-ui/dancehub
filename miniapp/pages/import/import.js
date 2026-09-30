const app = getApp();
const api = require("../../services/api");
const { dateKey, addDays, todayKey, parseKey } = require("../../utils/date");
const { toast } = require("../../utils/toast");
const { confirm } = require("../../utils/confirm");
const { onNavTop } = require("../../utils/scroll-top");
// 城市面板复用首页/发现页那套（能搜汉字/拼音/首字母、能定位）。
// 录入页只借用它的选择器，不切全局城市 —— 见下面的 applyCity。
const CP = require("../../utils/city-picker-mixin");

const DIFF_OPTIONS = ["不限", "入门", "进阶", "高阶"];
const DIFF_VALUE = {
  不限: "ALL_LEVELS",
  入门: "BEGINNER",
  进阶: "INTERMEDIATE",
  高阶: "ADVANCED",
};

/**
 * 补录的「行程状态」三选一。
 *
 * 以前补录只往库里丢一条课程数据，用户录完还得回课表再点一次预约 ——
 * 结果「我录过的课」在预约记录里永远查不到。而专程来补录一节课的人
 * 本来就是打算去上它，所以这里把两件事合成一步。
 *
 * value 直接对应服务端 imports/schedule 的 book 字段；
 * 空字符串 = 只记录（服务端收到空值就不建预约）。
 */
const BOOK_OPTIONS = [
  { value: "CONFIRMED", title: "已约", sub: "我在店里已经约好了" },
  { value: "PENDING", title: "想上", sub: "先记着，开课前提醒我" },
  { value: "", title: "只记录", sub: "不约也不提醒，先把课记下来" },
];

const BOOK_TEXT = {
  CONFIRMED: "已录入并标记为已约",
  PENDING: "已录入，开课前会提醒你",
  "": "已录入",
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
Page(
  Object.assign({}, CP.methods, {
    onNavTop,

    data: Object.assign({}, CP.data, {
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

      // 城市：默认跟着当前城市走，但**必须能改**。
      // 录入常发生在我们还没接入的地方（用户在三亚，库里只有北上广），
      // 沿用当前城市会把三亚的课记到上海名下，用户一看就知道不对。
      region: "CN",
      cities: [],
      filteredCities: [],
      cityId: null,
      cityName: "",
      // 库外城市：面板里搜不到时手输，服务端顺手把城市建出来
      customCityMode: false,
      customCityName: "",
      // null = 还没探测；false = 服务端老版本，建不了新城市
      cityCreate: null,

      studioName: "",
      courseName: "",
      coachName: "",
      submitBusy: false,
      lastResult: null,
      // 行程状态：默认「已约」—— 会来补录的人，绝大多数这节课是真要去上
      bookMode: "CONFIRMED",
      bookOpts: BOOK_OPTIONS,
      // 我录过的课（只有本人可见，所以列表也只列本人的）
      mine: [],
    }),

    async onShow() {
      this.loadMine();
      this.ensureCities();
      this.probeCityCreate();
    },

    /** 城市列表来自 app 初始化，偶尔还没就绪就自己拉一次 */
    async ensureCities() {
      if ((this.data.cities || []).length) return;
      try {
        await api.ensureReady();
        let cities = app.globalData.cities || [];
        if (!cities.length) {
          cities = (await api.apiCities()) || [];
          app.globalData.cities = cities;
        }
        const region = app.globalData.region || "CN";
        const sameRegion = cities.filter((c) => c.region === region);
        // 从课表页「＋」进来时带着那座城市（this.presetCityId），
        // 别自作主张换回「当前城市」—— 用户正在录的是他眼下看的那个城市。
        const preferred = this.presetCityId || app.globalData.cityId;
        const cur =
          sameRegion.find((c) => c.id === preferred) || sameRegion[0] || null;
        this.setData(
          Object.assign(
            { region, cities },
            cur ? this.syncCityView(region, cur.id, cities) : { filteredCities: sameRegion },
          ),
        );
      } catch (e) {
        console.error("[import] 城市列表载入失败:", e.message);
      }
    },

    /**
     * 面板里选完城市 —— 只更新本页字段，**不切全局城市**。
     * 录一节课不该把用户当前看的城市也换掉（录完还要回去看课表）。
     */
    applyCity() {
      this.setData({ customCityMode: false, customCityName: "" });
    },

    /**
     * 「库外城市」入口：面板里搜不到时手输城市名。
     * 建城市是服务端能力，老版本没有 —— 探测一次，不支持就别让用户白填。
     */
    async tapCustomCity() {
      if (this.data.cityCreate === false) {
        return toast(this, "服务端还没升级，暂时只能选列表里的城市");
      }
      this.setData({
        customCityMode: !this.data.customCityMode,
        customCityName: this.data.customCityMode ? "" : this.data.customCityName,
        cityPickerVisible: false,
      });
    },

    /** 探测服务端是否支持建城市（只探一次，结果缓存到页面实例） */
    async probeCityCreate() {
      if (this.data.cityCreate != null) return;
      try {
        await api.ensureReady();
        await api.apiMyCities();
        this.setData({ cityCreate: true });
      } catch (e) {
        this.setData({ cityCreate: false });
      }
    },
    onCustomCity(e) {
      this.setData({ customCityName: e.detail.value });
    },

    /**
     * 城市面板里搜「三亚」没命中 → 组件把这个词抛过来，
     * 直接切成手输模式并填好名字，省得用户关掉面板再打一遍。
     */
    onPickCustomCity(e) {
      const name = String((e.detail && e.detail.name) || "").trim();
      if (!name) return;
      if (this.data.cityCreate === false) {
        return toast(this, "服务端还没升级，暂时只能选列表里的城市");
      }
      this.setData({
        customCityMode: true,
        customCityName: name,
        cityId: null,
        cityName: "",
        cityPickerVisible: false,
      });
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

  onLoad(o) {
    const today = todayKey();
    const opts = o || {};
    // 从课表页「＋」进来：带上当前城市和选中的那一天，用户不用再选一遍。
    // 这是「在某个日期下补一节课」最常见的场景 —— 发现这天缺课，就地补上。
    const init = {
      dateText: today,
      dateStart: today,
      // ⚠ addDays 收 Date，today 是 "2026-09-30" 这种字符串 ——
      // 直接传会抛 `d.getTime is not a function`，onLoad 中断、日期全部填不上。
      dateEnd: dateKey(addDays(parseKey(today), 13)),
      endAuto: addMinutes(this.data.startText, 90),
    };
    if (opts.cityId) {
      this.presetCityId = Number(opts.cityId);
      init.cityId = Number(opts.cityId);
      init.cityName = decodeURIComponent(opts.cityName || "");
    }
    // 日期早于今天没意义；晚于可选上限就把上限放开，保证他能选到那一天
    if (opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
      init.dateText = opts.date < today ? today : opts.date;
      if (init.dateText > init.dateEnd) init.dateEnd = init.dateText;
    }
    this.setData(init);
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
  tapBook(e) {
    this.setData({ bookMode: e.currentTarget.dataset.value });
  },

  async submit() {
    const s = this.data;
    if (!s.studioName.trim()) return toast(this, "先填门店名");
    if (!s.courseName.trim()) return toast(this, "先填课程名");
    // 库外城市走手输，否则必须有 cityId —— 两者都没有课就不知道该挂在哪个城市
    if (!s.customCityMode && !s.cityId) return toast(this, "先选城市");
    if (s.customCityMode && !String(s.customCityName || "").trim())
      return toast(this, "先填城市名");
    if (s.submitBusy) return;

    this.setData({ submitBusy: true });
    try {
      await api.ensureReady();
      const res = await api.apiImportSchedule({
        studioName: s.studioName.trim(),
        // 二选一：手输城市时故意不传 cityId，让服务端按名字取/建城市
        cityId: s.customCityMode ? null : s.cityId,
        cityName: s.customCityMode ? String(s.customCityName || "").trim() : "",
        region: s.region,
        date: s.dateText,
        startTime: s.startText,
        endTime: s.endText || s.endAuto,
        courseName: s.courseName.trim(),
        coachName: s.coachName.trim(),
        difficulty: DIFF_VALUE[s.diffs[s.diffIndex]],
        // 行程状态：服务端会在同一个事务里把课程和预约一起建出来
        book: s.bookMode,
      });

      // 回执按服务端实际建出来的状态说 —— 它说没建成就一定是没建成，
      // 前端默认自己是「已约」会在服务出错时对着用户撒谎。
      const key = res && res.bookingStatus ? res.bookingStatus : "";
      toast(this, BOOK_TEXT[key] || "已录入", "success");
      this.setData({
        lastResult: {
          studio: s.studioName.trim(),
          city: s.customCityMode ? String(s.customCityName || "").trim() : s.cityName,
          date: s.dateText,
          time: s.startText,
          course: s.courseName.trim(),
          bookText: BOOK_TEXT[key] || "已录入",
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
}),
);

/** 没选结束时间就按 90 分钟一节（多数舞室的单课时长） */
function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + mins;
  const hh = String(Math.min(23, Math.floor(total / 60))).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return hh + ":" + mm;
}
