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

    /**
     * 双击导航栏顶部 → 回到顶部。
     * iOS 有系统级的「双击状态栏回顶」，安卓没有对应手势，
     * 所以自定义导航条时必须自己补一个，否则安卓用户滑到底只能手动往上扒。
     * 返回/头像按钮用 catchtap，避免点它们时也被算进双击。
     */
    onNavTap() {
      const now = Date.now();
      const last = this._lastNavTap || 0;
      this._lastNavTap = now;
      if (now - last > 320) return;
      this._lastNavTap = 0;
      this.triggerEvent("top");
    },
  },
});