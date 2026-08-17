const app = getApp();

Page({
  data: {
    region: "CN",
  },

  onLoad() {
    this.setData({ region: app.globalData.region });
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      const tb = this.getTabBar();
      tb.setData({ selected: 2 });
      tb.refreshBadge();
    }
    if (this.data.region !== app.globalData.region) {
      this.setData({ region: app.globalData.region });
    }
  },
});