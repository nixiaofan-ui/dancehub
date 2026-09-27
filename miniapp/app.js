const { apiLogin, apiCities, apiSubscribeConfig } = require("./services/api");
const { USE_CLOUD, CLOUD_RUNNER_ID } = require("./utils/config");
const { locateCity, readLocateCache } = require("./utils/locate");

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
    // 用户是否手动选过城市（选过就不再自动定位，别抢方向盘）
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
   * @param {"manual"|"locate"|"follow"} source 城市是怎么来的：
   *   manual —— 用户自己选的，写进 dh_city_manual，以后不再自动定位；
   *   locate/follow —— 系统给的，不算用户选择，仍可被预约城市拽走。
   */
  setCity(region, cityId, source) {
    this.globalData.region = region;
    this.globalData.cityId = cityId;
    const manual = source === "manual";
    this.globalData.cityManual = manual;
    try {
      wx.setStorageSync("dh_region", region);
      wx.setStorageSync("dh_cityId", cityId);
      wx.setStorageSync("dh_city_manual", manual);
    } catch (e) {
      // 存储失败不影响本次使用（下次启动回落默认城市）
    }
  },

  /**
   * 后台定位，不阻塞首屏。
   *
   * 为什么不在 init 里 await：用户面对授权弹窗可能一直不点，await 会把首屏
   * 卡死在空白。宁可先用默认城市渲染出来，定位好了再切（课表页 onShow 会接管）。
   * 但「7 天内定位过」的缓存是同步可读的，那种情况下 init 里就直接用，
   * 老用户不会看到城市跳变。
   */
  locateInBackground() {
    if (wx.getStorageSync("dh_city_manual")) return; // 用户选过，不再打扰
    locateCity({ useCache: true })
      .then((r) => {
        if (!r || r.code !== "ok" || !r.city) return;
        if (r.city.id === this.globalData.cityId) return;
        this.setCity(r.city.region, r.city.id, "locate");
        this.globalData.locatedCity = r.city;
      })
      .catch((e) => console.warn("[dancehub] 后台定位失败:", e && e.message));
  },

  async init() {
    try {
      this.globalData.cityManual = !!wx.getStorageSync("dh_city_manual");
      const res = await apiLogin();
      this.globalData.token = res.token;

      const cities = await apiCities();
      this.globalData.cities = cities;
      // 记住上次选的城市：切到海外后重启不该被拉回国内。
      // 已失效（城市下架/改名）时回落到国内第一个城市。
      const savedRegion = wx.getStorageSync("dh_region");
      const savedCityId = wx.getStorageSync("dh_cityId");
      const saved = cities.find((c) => c.id === savedCityId && c.region === savedRegion);
      // 没手动选过城市时，先用一周内的定位缓存（同步读，首屏就是对的）
      const cachedLoc = this.globalData.cityManual
        ? null
        : (function () {
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
    } catch (e) {
      console.error("[dancehub] init failed:", e);
      // 页面可以据此显示「连不上服务」而不是干等着空白。
      // 注意：不要在这里 throw —— app.ready 变成 rejected 会让所有页面的
      // ensureReady 直接抛异常，反而把首屏打空。
      this.globalData.initError = (e && e.message) || "初始化失败";
    }
  },
});
