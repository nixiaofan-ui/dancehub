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
      this.getTabBar().setData({ selected: 2 });
    }
    if (this.data.region !== app.globalData.region) {
      this.setData({ region: app.globalData.region });
    }
  },
});