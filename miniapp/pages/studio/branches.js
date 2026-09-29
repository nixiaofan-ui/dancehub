const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");
const { todayKey } = require("../../utils/date");
const { onNavTop } = require("../../utils/scroll-top");
const { branchOf, stripDistrictTag } = require("../../utils/brand");

/**
 * 品牌分店列表：一个品牌的多家门店，逐店关注。
 *
 * 为什么要有这一页：发现页把同城多店品牌**收成一行**（避免同品牌连着刷屏），
 * 代价是没有单店入口 —— 用户想只关注离家近的那家分店时无处下手，
 * 只能被动接受「品牌行一点就把所有分店的课全倒出来」。
 *
 * 这里把的分店重新摊平：每行一家门店 + 独立关注按钮，点行进单店课表，
 * 底部保留「合并看全部」的入口，两条路径都不丢。
 *
 * 入口：
 *   发现页品牌行右侧箭头 → bins?ids=1,2,3&name=AB DANCE
 *   多店课表页「关注分店」 → 同上
 */
Page({
  onNavTop,

  data: {
    name: "分店",
    subtitle: "",
    stores: [],
    followedCount: 0,
    allFollowed: false,
    loading: true,
  },

  onLoad(query) {
    this._ids = String(query.ids || "")
      .split(",")
      .map(Number)
      .filter(Boolean);
    this.setData({ name: decodeURIComponent(query.name || "分店") });
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await api.ensureReady();
      const [details, follows] = await Promise.all([
        this.fetchStores(),
        api.apiFollows().catch(() => []),
      ]);
      // 今日各店课数一次多店接口就能全拿到；失败只是少个数字，不该挡住列表
      const counts = await this.fetchTodayCounts();
      const followedIds = (follows || []).map((f) => f.studio.id);
      const stores = details.map((s) => {
        // 行标题只要分店名（品牌已经写在页面标题里）。
        // ⚠ 别退回 splitStudioName —— 那个的主名是给发现页排版用的，
        //   而「G-STEPS·祥云小镇店（北京）」这类店名里分店名就在主名里，
        //   用主名当行标题会把「G-STEPS·」也带进来，40 行全是同一个前缀。
        //   取不出分店名时退回「去掉行政区尾巴的完整店名」，至少每行还能区分开。
        const short = branchOf(s.name) || stripDistrictTag(s.name) || s.name;
        return {
          id: s.id,
          short, // 品牌已显示在标题里，行内只留分店名
          full: s.name,
          cityName: s.cityName || (s.city && s.city.name) || "",
          address: s.address || "",
          today: counts[s.id] || 0,
          followed: followedIds.includes(s.id),
        };
      });
      const followedCount = stores.filter((s) => s.followed).length;
      this.setData({
        stores,
        followedCount,
        allFollowed: stores.length > 0 && followedCount === stores.length,
        subtitle: stores.length ? `${stores.length} 家分店` : "",
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      toast(this, e.message);
    }
  },

  /**
   * 门店详情有两条来源。
   * ① 来源页（发现页）会把完整门店对象塞进 globalData，省一次往返 ——
   *    那条路径本来就是「品牌行带着它自己的 stores 列表过来的」；
   * ② 从多店课表页进来时手上只有 ids，逐个问一次（分店通常只有几家）。
   */
  async fetchStores() {
    const cached = (app.globalData && app.globalData.brandStores) || [];
    const hit = this._ids.map((id) => cached.find((s) => Number(s.id) === id));
    if (hit.length && hit.every(Boolean)) return hit;
    const details = await Promise.all(
      this._ids.map((id) => api.apiStudioDetail(id).catch(() => null)),
    );
    return details.map((s, i) => s || { id: this._ids[i], name: "门店 " + this._ids[i] });
  },

  async fetchTodayCounts() {
    const map = {};
    if (!this._ids.length) return map;
    try {
      const res = await api.apiMultiTimeline(this._ids, todayKey(), todayKey());
      const items = (res && res.items) || (Array.isArray(res) ? res : []) || [];
      for (const s of items) {
        const sid = s.studio && s.studio.id;
        if (sid) map[sid] = (map[sid] || 0) + 1;
      }
    } catch (e) {
      // 课数只是辅助信息，吞掉
    }
    return map;
  },

  /** 关注态写回：整份列表重建，避免 WXML 里算 index（那里不支持表达式方法调用） */
  paint(nextById) {
    const stores = this.data.stores.map((s) => {
      const followed = nextById.hasOwnProperty(s.id) ? nextById[s.id] : s.followed;
      return Object.assign({}, s, { followed });
    });
    const followedCount = stores.filter((s) => s.followed).length;
    this.setData({
      stores,
      followedCount,
      allFollowed: stores.length > 0 && followedCount === stores.length,
    });
  },

  async toggleFollow(e) {
    const id = Number(e.currentTarget.dataset.id);
    const cur = this.data.stores.find((s) => s.id === id);
    if (!cur) return;
    const next = !cur.followed;
    const patch = {};
    patch[id] = next;
    this.paint(patch); // 先乐观更新，请求失败再回滚 + 提示
    try {
      if (next) await api.apiFollow(id);
      else await api.apiUnfollow(id);
      toast(this, next ? "已关注" : "已取消关注", "success");
    } catch (err) {
      const back = {};
      back[id] = cur.followed;
      this.paint(back);
      toast(this, err.message);
    }
  },

  /**
   * 一键全关注 / 全取消。
   * 并发打 + 逐条 settle：某一家失败不影响其余，失败数单独提示，避免
   * 「12 家里 1 家报错，toast 却说全部失败」这种误导。
   */
  async toggleAll() {
    const target = !this.data.allFollowed;
    const diffs = this.data.stores.filter((s) => s.followed !== target);
    if (!diffs.length) return;
    const patch = {};
    diffs.forEach((s) => {
      patch[s.id] = target;
    });
    this.paint(patch);
    const settled = await Promise.all(
      diffs.map((s) =>
        target ? api.apiFollow(s.id).catch(() => 0) : api.apiUnfollow(s.id).catch(() => 0),
      ),
    );
    const failed = settled.filter((r) => r === 0).length;
    if (failed) toast(this, `${diffs.length - failed} 家成功，${failed} 家失败`);
    else toast(this, target ? `已关注 ${diffs.length} 家分店` : "已取消关注", "success");
  },

  goStore(e) {
    wx.navigateTo({ url: "/pages/studio/weekly?id=" + Number(e.currentTarget.dataset.id) });
  },

  /**
   * 合并看全部课表。
   * 已关注过几家就默认勾这几家 —— 用户既然单独关注了，多半是想只看它们；
   * 一家都没关注才全选（此时 weekly 的默认行为和原来一致）。
   */
  goAll() {
    const ids = this.data.stores.map((s) => s.id).join(",");
    const followed = this.data.stores.filter((s) => s.followed).map((s) => s.id);
    let url =
      "/pages/studio/weekly?ids=" +
      ids +
      "&title=" +
      encodeURIComponent(this.data.name) +
      "&first=1";
    if (followed.length) url += "&on=" + followed.join(",");
    wx.navigateTo({ url });
  },
});
