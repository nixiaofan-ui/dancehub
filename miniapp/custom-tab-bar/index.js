Component({
  data: {
    selected: 0,
    list: [
      { pagePath: "/pages/index/index", text: "课表", icon: "📅" },
      { pagePath: "/pages/discover/discover", text: "发现", icon: "🧭" },
      { pagePath: "/pages/import/import", text: "", icon: "", isCenter: true },
      { pagePath: "/pages/profile/profile", text: "我的", icon: "👤" },
    ],
  },

  methods: {
    switchTab(e) {
      const index = e.currentTarget.dataset.index;
      const item = this.data.list[index];
      wx.switchTab({ url: item.pagePath });
    },
  },
});