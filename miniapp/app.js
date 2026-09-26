const { apiLogin, apiCities, apiSubscribeConfig } = require("./services/api");
const { USE_CLOUD, CLOUD_RUNNER_ID } = require("./utils/config");

App({
  globalData: {
    token: "",
    region: "CN",
    cityId: null,
    cities: [],
    pendingJump: false,
    pendingBookings: 0,
    classReminderTplId: "",
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
   */
  setCity(region, cityId) {
    this.globalData.region = region;
    this.globalData.cityId = cityId;
    try {
      wx.setStorageSync("dh_region", region);
      wx.setStorageSync("dh_cityId", cityId);
    } catch (e) {
      // 存储失败不影响本次使用（下次启动回落默认城市）
    }
  },

  async init() {
    try {
      const res = await apiLogin();
      this.globalData.token = res.token;

      const cities = await apiCities();
      this.globalData.cities = cities;
      // 记住上次选的城市：切到海外后重启不该被拉回国内。
      // 已失效（城市下架/改名）时回落到国内第一个城市。
      const savedRegion = wx.getStorageSync("dh_region");
      const savedCityId = wx.getStorageSync("dh_cityId");
      const saved = cities.find((c) => c.id === savedCityId && c.region === savedRegion);
      const fallback = cities.find((c) => c.region === "CN") || cities[0];
      const picked = saved || fallback;
      this.globalData.region = picked ? picked.region : "CN";
      this.globalData.cityId = picked ? picked.id : null;

      try {
        const cfg = await apiSubscribeConfig();
        this.globalData.classReminderTplId = cfg.classReminderTplId || "";
      } catch (e) {
        this.globalData.classReminderTplId = "";
      }
    } catch (e) {
      console.error("[dancehub] init failed:", e);
    }
  },
});
