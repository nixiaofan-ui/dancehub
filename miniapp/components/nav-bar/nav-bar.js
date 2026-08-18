Component({
  properties: {
    title: {
      type: String,
      value: "DanceHub",
    },
    showAvatar: {
      type: Boolean,
      value: false,
    },
    showBack: {
      type: Boolean,
      value: false,
    },
    accent: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
  },

  lifetimes: {
    attached() {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.setData({
        statusBarHeight: info.statusBarHeight,
        navBarHeight: 44,
      });
    },
  },

  methods: {
    onBack() {
      wx.navigateBack();
    },
    onAvatar() {
      this.triggerEvent("avatar");
    },
  },
});