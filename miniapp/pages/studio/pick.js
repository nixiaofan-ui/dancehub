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
    // 勾选态只有一个真源（Set，保留选择顺序，对比时的门店顺序就是用户的勾选顺序）
    this._picked = new Set();
    await api.ensureReady();
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const list = await api.apiStudios({ cityId: app.globalData.cityId });
      this._all = list || [];
      this.setData({ studios: this.rows(this.data.keyword), loading: false });
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

  /**
   * 渲染行 = 过滤后的门店 + 勾选态。
   *
   * ⚠ 勾选态必须在这里算好写进数据。早先模板里写的是
   *   `class="row {{picked.indexOf(item.id) >= 0 ? 'on' : ''}}"` ——
   *   WXML 表达式对数组方法的支持不完整，indexOf 实际不生效，
   *   结果勾了不打勾、不变色，用户以为点了没反应（2026-09-29 老板反馈的就是这个）。
   *   weekly 页的门店 chip 早就是「JS 里算 on」的写法，这里对齐。
   */
  rows(kw) {
    const picked = this._picked || new Set();
    return this.filter(this._all || [], kw).map((s) => ({ ...s, on: picked.has(s.id) }));
  },

  onSearch(e) {
    const keyword = e.detail.value;
    this.setData({ keyword, studios: this.rows(keyword) });
  },

  toggle(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (this._picked.has(id)) this._picked.delete(id);
    else this._picked.add(id);
    const on = this._picked.has(id);
    // 只改被点的那一行：整表重排会让长列表滚动位置跳动
    this.setData({
      picked: [...this._picked],
      studios: this.data.studios.map((s) => (s.id === id ? { ...s, on } : s)),
    });
  },

  clear() {
    this._picked.clear();
    this.setData({ picked: [], studios: this.data.studios.map((s) => ({ ...s, on: false })) });
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
