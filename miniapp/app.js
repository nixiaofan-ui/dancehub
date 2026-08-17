const { apiLogin, apiCities, apiSubscribeConfig } = require("./services/api");

App({
  globalData: {
    token: "",
    region: "CN",
    cityId: null,
    cities: [],
    pendingJump: false,
    classReminderTplId: "",
  },

  onLaunch() {
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
