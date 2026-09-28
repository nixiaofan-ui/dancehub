/**
 * 城市选择面板的页面侧逻辑 —— 首页和发现页各有一模一样的城市切换器，
 * 这里抽成 mixin，页面 spread 进去即可。
 *
 * 背景：库里现在有 100 来个城市，原来是一条横向 chip 条一直滑，
 * 找一个二三线城市要滑半天。改法是「热门 8 个常驻 + 全量面板」，
 * 面板里能搜（汉字/拼音/首字母缩写）、能按字母跳、能定位。
 *
 * 接入方式：
 *   const CP = require("../../utils/city-picker-mixin");
 *   Page(Object.assign({}, CP.methods, {
 *     data: Object.assign({}, CP.data, { ...页面自己的字段 }),
 *     ...
 *   }))
 *
 * 约定页面实现两个方法（不在 mixin 里写死，因为两页后续动作不同）：
 *   applyCity(cityId)        选完城市后的动作（切大学?
 *                            通常是 app.setCity + load）
 *   已有 tapLocate() 的页面优先用自己的（index 页有额外的 follow 开关要处理）
 */

const HOT_COUNT = 8;

/**
 * 常驻 chip：服务端已按门店数倒序，取前 8 个当热门。
 * 但当前选中的城市一定要露出来——哪怕它是个只有两家店的小城，
 * 否则用户切过去之后 chip 条上找不到「我选的是谁」，会以为没切成功。
 */
function pickHot(filtered, cityId) {
  const top = filtered.slice(0, HOT_COUNT);
  if (cityId == null) return top;
  if (top.some((c) => c.id === cityId)) return top;
  const cur = filtered.find((c) => c.id === cityId);
  if (!cur) return top;
  return [cur].concat(top.slice(0, HOT_COUNT - 1));
}

/** 当前选中城市的名字，给「全部城市」按钮当标题用 */
function currentCityName(filtered, cityId) {
  const c = filtered.find((x) => x.id === cityId);
  return c ? c.name : "";
}

const methods = {
  /**
   * 统一的城市视图刷新入口。
   * 页面凡是原来直接 setData({region, cityId, cities, filteredCities}) 的地方，
   * 换成调这个，chip 条和面板的数据就都是同步的，不会出现「面板里显示选中=北京、
   * 上面 chip 条还停在上海」。
   */
  syncCityView(region, cityId, cities) {
    const filtered = (cities || []).filter((c) => c.region === region);
    return {
      region,
      cityId,
      cities: cities || [],
      filteredCities: filtered,
      hotCities: pickHot(filtered, cityId),
      cityName: currentCityName(filtered, cityId),
    };
  },

  openCityPicker() {
    if (!(this.data.cities || []).length) {
      wx.showToast({ title: "城市列表还没加载完", icon: "none" });
      return;
    }
    this.setData({ cityPickerVisible: true });
  },

  closeCityPicker() {
    this.setData({ cityPickerVisible: false });
  },

  onPickCity(e) {
    const cityId = e.detail && e.detail.id;
    if (cityId == null || cityId === this.data.cityId) {
      this.setData({ cityPickerVisible: false });
      return;
    }
    this.setData({
      ...this.syncCityView(this.data.region, cityId, this.data.cities),
      cityPickerVisible: false,
    });
    if (typeof this.applyCity === "function") this.applyCity(cityId);
  },

  /**
   * 面板里的「📍 用当前位置」。
   * 页面自己有 tapLocate 就直接用它的（首页那里还要额外关掉 auto-follow），
   * 没有则走 mixin 自带的简版。
   */
  onPickLocate() {
    if (typeof this.tapLocate === "function") {
      this.tapLocate();
      this.setData({ cityPickerVisible: false });
      return;
    }
    this.pickLocateFallback();
  },

  async pickLocateFallback() {
    const { locateCity, openSetting } = require("./locate");
    this.setData({ locating: true });
    try {
      let r = await locateCity({ useCache: false });
      if (r.code === "denied") {
        const s = await openSetting();
        if (s === "granted") r = await locateCity({ useCache: false });
      }
      this.setData({ locating: false });
      if (r.code !== "ok" || !r.city) {
        wx.showToast({
          title:
            r.code === "denied"
              ? "没给定位权限"
              : r.code === "no-match"
                ? "你所在的城市还没接入"
                : "定位失败",
          icon: "none",
        });
        return;
      }
      const cities = this.data.cities || [];
      this.setData({
        ...this.syncCityView(r.city.region, r.city.id, cities),
        cityPickerVisible: false,
      });
      if (typeof this.applyCity === "function") this.applyCity(r.city.id);
      wx.showToast({ title: "已定位到" + r.city.name, icon: "none" });
    } catch (e) {
      this.setData({ locating: false });
      wx.showToast({ title: "定位失败", icon: "none" });
    }
  },
};

module.exports = {
  HOT_COUNT,
  data: {
    cityPickerVisible: false,
    hotCities: [],
    cityName: "",
    locating: false,
  },
  methods,
};
