const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");

/**
 * 自选组合：跨品牌挑任意几家门店，同屏对比它们当天的课。
 *
 * 为什么单独做一页：品牌页入口只能对比「同一个品牌的分店」，而真实需求是
 * 「我公司附近这三家、不管是不是一个牌子」——  constrain 在品牌内没意义。
 * 选完直接复用多店课表页（weekly?ids=...），不另起一套视图。
 */
Page({
  data: {
    keyword: "",
    studios: [],
    picked: [], // 已选门店 id
    loading: true,
    cityName: "",
  },

  async onLoad() {
    const g = app.globalData;
    const city = (g.cities || []).find((c) => c.id === g.cityId);
    this.setData({ cityName: city ? city.name : "" });
    await api.ensureReady();
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const list = await api.apiStudios({ cityId: app.globalData.cityId });
      this._all = list || [];
      this.setData({ studios: this.filter(this._all, this.data.keyword), loading: false });
    } catch (e) {
      this.setData({ loading: false });
      toast(this, e.message);
    }
  },

  filter(list, kw) {
    const k = (kw || "").trim().toLowerCase();
    if (!k) return list;
    return list.filter((s) => String(s.name || "").toLowerCase().indexOf(k) >= 0);
  },

  onSearch(e) {
    const keyword = e.detail.value;
    this.setData({ keyword, studios: this.filter(this._all || [], keyword) });
  },

  toggle(e) {
    const id = Number(e.currentTarget.dataset.id);
    const picked = this.data.picked.slice();
    const at = picked.indexOf(id);
    if (at >= 0) picked.splice(at, 1);
    else picked.push(id);
    this.setData({ picked });
  },

  clear() {
    this.setData({ picked: [] });
  },

  /** 少于两家没法「对比」——一家直接看它自己的课表即可 */
  goCompare() {
    const picked = this.data.picked;
    if (picked.length < 2) return toast(this, "至少选两家门店才能对比");
    if (picked.length > 12) return toast(this, "一次最多对比 12 家门店");
    const title = `自选组合（${picked.length} 家）`;
    wx.navigateTo({
      url: "/pages/studio/weekly?ids=" + picked.join(",") + "&title=" + encodeURIComponent(title),
    });
  },
});
