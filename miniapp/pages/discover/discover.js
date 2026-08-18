const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");
const { PLATFORM_LABEL } = require("../../utils/constants");

Page({
  data: {
    region: "CN",
    cities: [],
    cityId: null,
    keyword: "",
    studios: [],
    followedIds: [],
    loading: false,
  },

  async onLoad() {
    const g = app.globalData;
    this.setData({ region: g.region, cityId: g.cityId, cities: g.cities });
    this.load();
  },

  async onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      const tb = this.getTabBar();
      tb.setData({ selected: 1 });
      tb.refreshBadge();
    }
    const g = app.globalData;
    if (this.data.region !== g.region || this.data.cityId !== g.cityId) {
      this.setData({ region: g.region, cityId: g.cityId, cities: g.cities });
      this.load();
    }
  },

  async load() {
    if (!this.data.cityId) return;
    await api.ensureReady();
    this.setData({ loading: true });
    try {
      const params = { cityId: this.data.cityId };
      if (this.data.keyword) params.keyword = this.data.keyword;
      const [rawStudios, follows] = await Promise.all([
        api.apiStudios(params),
        api.apiFollows(),
      ]);
      const followedIds = follows.map((f) => f.studio.id);
      const studios = rawStudios.map((s) => ({
        ...s,
        followed: followedIds.includes(s.id),
        platformLabel: PLATFORM_LABEL[s.platform] || s.platform,
        initial: (s.name || "?").charAt(0),
      }));
      this.setData({ studios, followedIds, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      toast(this, e.message);
    }
  },

  switchRegion(e) {
    const region = e.currentTarget.dataset.r;
    if (region === this.data.region) return;
    const city = app.globalData.cities.find((c) => c.region === region);
    app.globalData.region = region;
    app.globalData.cityId = city ? city.id : null;
    this.setData({ region, cityId: city ? city.id : null });
    this.load();
  },

  selectCity(e) {
    const cityId = e.currentTarget.dataset.id;
    if (cityId === this.data.cityId) return;
    app.globalData.cityId = cityId;
    this.setData({ cityId });
    this.load();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearchConfirm() {
    this.load();
  },

  clearKeyword() {
    this.setData({ keyword: "" });
    this.load();
  },

  goWeekly(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: "/pages/studio/weekly?id=" + id,
    });
  },

  async toggleFollow(e) {
    const id = e.currentTarget.dataset.id;
    const isFollowed = this.data.followedIds.includes(id);
    try {
      if (isFollowed) {
        await api.apiUnfollow(id);
      } else {
        await api.apiFollow(id);
      }
      const followedIds = isFollowed
        ? this.data.followedIds.filter((x) => x !== id)
        : this.data.followedIds.concat(id);
      const studios = this.data.studios.map((s) =>
        s.id === id ? { ...s, followed: !isFollowed } : s,
      );
      this.setData({ followedIds, studios });
      toast(this, isFollowed ? "已取消关注" : "已关注", "success");
    } catch (err) {
      toast(this, err.message);
    }
  },
});
