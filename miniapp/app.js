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

  async init() {
    try {
      const res = await apiLogin();
      this.globalData.token = res.token;

      const cities = await apiCities();
      const cn = cities.find((c) => c.region === "CN");
      this.globalData.cities = cities;
      this.globalData.region = "CN";
      this.globalData.cityId = cn ? cn.id : cities[0]?.id || null;

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
