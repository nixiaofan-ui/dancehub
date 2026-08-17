Component({
  data: {
    selected: 0,
    animating: -1,
    list: [
      { pagePath: "/pages/index/index", text: "课表", icon: "📅" },
      { pagePath: "/pages/discover/discover", text: "发现", icon: "🧭" },
      { pagePath: "/pages/import/import", text: "发布", icon: "", isCenter: true },
      { pagePath: "/pages/profile/profile", text: "我的", icon: "👤", dot: true },
    ],
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
  },
});