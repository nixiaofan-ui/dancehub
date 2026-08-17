const api = require("../services/api");

Component({
  data: {
    selected: 0,
    animating: -1,
    badge: false,
    list: [
      { pagePath: "/pages/index/index", text: "课表", icon: "📅" },
      { pagePath: "/pages/discover/discover", text: "发现", icon: "🧭" },
      { pagePath: "/pages/import/import", text: "发布", icon: "", isCenter: true },
      { pagePath: "/pages/profile/profile", text: "我的", icon: "👤", dot: true },
    ],
  },

  show() {
    this.refreshBadge();
  },

  methods: {
    switchTab(e) {
      const index = e.currentTarget.dataset.index;
      const item = this.data.list[index];
      this.pulse(index);
      if (this.data.selected !== index) {
        wx.switchTab({ url: item.pagePath });
      }
    },

    pulse(index) {
      this.setData({ animating: index });
      setTimeout(() => {
        this.setData({ animating: -1 });
      }, 320);
    },

    async refreshBadge() {
      try {
        await api.ensureReady();
        const res = await api.apiPendingCount();
        const count = (res && res.count) || 0;
        getApp().globalData.pendingBookings = count;
        this.setData({ badge: count > 0 });
      } catch (e) {
        // 拉取失败时保持现状，不强制显示红点
      }
    },
  },
});