const { apiLogin, apiCities, apiSubscribeConfig } = require("./services/api");
const { USE_CLOUD, CLOUD_RUNNER_ID } = require("./utils/config");
const { locateCity, readLocateCache } = require("./utils/locate");

// 启动初始化的总超时上限：见 init() 里的说明
const INIT_TIMEOUT_MS = 15000;

App({
  globalData: {
    token: "",
    region: "CN",
    cityId: null,
    cities: [],
    pendingJump: false,
    pendingBookings: 0,
    classReminderTplId: "",
    initError: "",
    // 后台定位成功后放在这里，课表页 onShow 取用并清空
    locatedCity: null,
    /**
     * 「本次会话」用户手动选过城市。
     *
     * ⚠ 这是**会话级**状态，不落盘，也刻意不用它挡住下次启动的自动定位 ——
     * 用户要的行为是「每次进小程序都定位到当前位置」，所以启动时该覆盖就覆盖；
     * 它的作用只有一个：本次会话里别让定位的迟到结果、或「跟随预约城市」
     * 把用户刚选的城市抢走。
     */
    cityManual: false,
  },

  onLaunch() {
    // 云托管模式：先 init 云开发客户端，后续 wx.cloud.callContainer 才会成功
    // CLOUD_RUNNER_ID 是云托管环境 ID（不是云开发环境 ID），二者是两套独立体系
    if (USE_CLOUD && typeof wx.cloud !== "undefined" && CLOUD_RUNNER_ID && !CLOUD_RUNNER_ID.startsWith("REPLACE_ME")) {
      try {
        wx.cloud.init({ env: CLOUD_RUNNER_ID, traceUser: false });
      } catch (e) {
        console.error("[dancehub] wx.cloud.init failed:", e);
      }
    }
    this.ready = this.init();
  },

  onShow() {
    if (this.globalData.pendingJump) {
      this.globalData.pendingJump = false;
      wx.showToast({
        title: "预约回来了？记得点\"我已约好\"哦~",
        icon: "none",
        duration: 3000,
      });
    }
  },

  /**
   * 设置当前城市并持久化。
   * 页面里切换地区/城市统一走这里，避免各处各自 setData 却忘了落盘，
   * 导致重启后回落到国内。
   *
   * @param {"manual"|"locate"} [source] 城市是怎么来的：
   *   manual —— 用户自己在本次会话里选的：本次会话内不再被定位/预约抢方向盘。
   *   locate —— 定位给的，不算用户表态。
   *
   * ⚠ 这里**不再写** `dh_city_manual`。
   *   旧实现把它当「用户选过城市」的长期标记，一旦为真就永久停掉自动定位；
   *   而「跟随预约城市」切城时没带 source，会把标记悄悄抹成 false ——
   *   结果就是用户手动选过的城市保不住，还得每次进来重新选。
   *   现在按用户的要求：定位每次启动都跑，手动选择只在本次会话内有效。
   */
  setCity(region, cityId, source) {
    this.globalData.region = region;
    this.globalData.cityId = cityId;
    if (source === "manual") this.globalData.cityManual = true;
    try {
      wx.setStorageSync("dh_region", region);
      wx.setStorageSync("dh_cityId", cityId);
    } catch (e) {
      // 存储失败不影响本次使用（下次启动回落默认城市）
    }
  },

  /**
   * 后台定位，不阻塞首屏。
   *
   * 为什么不在 init 里 await：用户面对授权弹窗可能一直不点，await 会把首屏
   * 卡死在空白。宁可先用上次的城市渲染出来，定位好了再切（课表页 onShow 会接管）。
   *
   * ⚠ 每次都真定位（useCache: false），不用定位缓存「省掉」这一趟 ——
   *   用户报的就是「每次进来都不是我所在的城市」。缓存只在首屏和失败兜底时读，
   *   见 utils/locate 的 CACHE_TTL 注释。
   */
  locateInBackground() {
    locateCity({ useCache: false })
      .then((r) => {
        if (!r || r.code !== "ok" || !r.city) return;
        // 用户本次会话已经自己选过城市：以他选的为准，别拿迟到的定位结果盖掉
        if (this.globalData.cityManual) return;
        if (r.city.id === this.globalData.cityId) return;
        this.setCity(r.city.region, r.city.id, "locate");
        this.globalData.locatedCity = r.city;
      })
      .catch((e) => console.warn("[dancehub] 后台定位失败:", e && e.message));
  },

  async init() {
    /**
     * 总闸：无论哪一步卡住，都要在有限时间内结束。
     *
     * 请求层虽然加了超时，但 wx.login 本身也可能既不 success 也不 fail
     * （开发者工具重开、云环境异常时就遇到过），那样 init() 会永远 pending。
     * app.ready 一 pending，所有页面的 ensureReady 就一起卡死，
     * 微信判定 appLaunch timeout，界面只剩一片背景色。
     *
     * 这里用 race 兜底：超时也走 catch 分支，把 initError 写进 globalData，
     * 页面据此渲染错误态 + 重试入口，而不是干等着白屏。
     */
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("初始化超时：服务无响应")), INIT_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.doInit(), guard]);
    } catch (e) {
      console.error("[dancehub] init failed:", e);
      // 页面可以据此显示「连不上服务」而不是干等着空白。
      // 注意：不要在这里 throw —— app.ready 变成 rejected 会让所有页面的
      // ensureReady 直接抛异常，反而把首屏打空。
      this.globalData.initError = (e && e.message) || "初始化失败";
    } finally {
      clearTimeout(timer);
    }
  },

  async doInit() {
      // 会话级状态，每次启动清零：定位马上会重跑一遍（见 locateInBackground）
      this.globalData.cityManual = false;
      const res = await apiLogin();
      this.globalData.token = res.token;

      const cities = await apiCities();
      this.globalData.cities = cities;
      // 记住上次用的城市：切到海外后重启不该被拉回国内，
      // 同时也是定位失败/没权限时的兜底。已失效（城市下架/改名）则回落到国内第一个城市。
      const savedRegion = wx.getStorageSync("dh_region");
      const savedCityId = wx.getStorageSync("dh_cityId");
      const saved = cities.find((c) => c.id === savedCityId && c.region === savedRegion);
      // 二级兜底：上次城市没了（下架/改名）时，用一天内的定位缓存顶上
      const cachedLoc = (function () {
        const c = readLocateCache();
        return c ? cities.find((x) => x.id === c.cityId) : null;
      })();
      // 兜底是「门店最多的国内城市」——没有定位权限时的默认展示
      const fallback = cities.find((c) => c.region === "CN") || cities[0];
      const picked = saved || cachedLoc || fallback;
      this.globalData.region = picked ? picked.region : "CN";
      this.globalData.cityId = picked ? picked.id : null;

      try {
        const cfg = await apiSubscribeConfig();
        this.globalData.classReminderTplId = cfg.classReminderTplId || "";
      } catch (e) {
        this.globalData.classReminderTplId = "";
      }

      // 首屏已经能渲染了，定位只做锦上添花（异步，失败也不影响使用）
      this.locateInBackground();
  },
});
