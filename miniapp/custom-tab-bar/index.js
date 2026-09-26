const api = require("../services/api");

Component({
  data: {
    selected: 0,
    animating: -1,
    badge: false,
    list: [
      // pose = 该 tab 的舞者剪影姿势（角度制，0deg 表示四肢自然下垂）
      // armL 为正 = 向左上摆动，armR 为负 = 向右上摆动
      {
        pagePath: "/pages/index/index",
        text: "课表",
        pose: { armL: 135, armR: -135, legL: 18, legR: -18 },
      },
      {
        pagePath: "/pages/discover/discover",
        text: "发现",
        pose: { armL: 145, armR: -15, legL: 34, legR: -30 },
      },
      {
        pagePath: "/pages/profile/profile",
        text: "我的",
        dot: true,
        pose: { armL: 55, armR: -145, legL: 14, legR: -20 },
      },
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