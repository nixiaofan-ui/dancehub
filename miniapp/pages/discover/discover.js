const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");
const { API_HOST } = require("../../utils/config");
const { onNavTop } = require("../../utils/scroll-top");

/** 「#」组没法直接当元素 id，映射成一个合法的锚点值 */
const anchorId = (letter) => "sec-" + (letter === "#" ? "SHARP" : letter);

/** 卡片上最多平铺几个舞种标签，多出来的收成「+N」 */
const MAX_TAGS = 3;

/**
 * 把「MAX POWER STUDIO（苏河湾店）」拆成主名 + 分店名。
 *
 * 为什么要拆：原来的排版把整串名字用 32rpx/900 的字重一股脑塞在一行，
 * 品牌名和「（苏河湾店）」一样重，加上全大写的英文品牌名，
 * 视觉上就是一块砖头，而且长名会撑破卡片把「关注」按钮顶出去。
 * 拆成两级后主名吃掉视觉重量，分店名降级成辅助信息，还能各自截断。
 *
 * 中英文括号都兼容；「（某某）」这种主名为空的角落情况不拆，原样返回。
 */
function splitStudioName(name) {
  const raw = (name || "").trim();
  const m = raw.match(/^(.*?)\s*[（(]\s*([^）)]+?)\s*[)）]\s*$/);
  if (!m || !m[1]) return { brand: raw, branch: "" };
  return { brand: m[1].trim(), branch: m[2].trim() };
}

/** 字母排序：「#」垫底，其余 A-Z */
function compareLetter(a, b) {
  if (a === b) return 0;
  if (a === "#") return 1;
  if (b === "#") return -1;
  return a < b ? -1 : 1;
}

/**
 * 保序切成「通讯录式」分组。
 * 组内顺序沿用接口给的顺序（服务端已按首字母+拼音排好），
 * 这里再对分组字母排序一次，兼容旧数据里没排好序的情况。
 */
function buildSections(studios) {
  const bucket = new Map();
  for (const s of studios) {
    const letter = s.groupLetter;
    if (!bucket.has(letter)) bucket.set(letter, []);
    bucket.get(letter).push(s);
  }
  const letters = [...bucket.keys()].sort(compareLetter);
  return { letters, sections: letters.map((letter) => ({ letter, studios: bucket.get(letter) })) };
}

Page({
  onNavTop,

  data: {
    region: "CN",
    cities: [],
    filteredCities: [],
    cityId: null,
    keyword: "",
    sections: [],
    letters: [],
    activeLetter: "",
    indexTip: false,
    statusBarHeight: 20,
    followedIds: [],
    loading: false,
    brands: [],
  },

  async onLoad() {
    const g = app.globalData;
    // 吸顶的分组标题要避开状态栏（自定义导航栏下顶部是系统状态栏）
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this._winH = info.windowHeight;
    const cities = g.cities || [];
    const filteredCities = cities.filter(c => c.region === g.region);
    this.setData({
      region: g.region,
      cityId: g.cityId,
      cities: cities,
      filteredCities: filteredCities,
      statusBarHeight: info.statusBarHeight || 20,
    });
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
      const cities = g.cities || [];
      const filteredCities = cities.filter(c => c.region === g.region);
      this.setData({ region: g.region, cityId: g.cityId, cities: cities, filteredCities: filteredCities });
      this.load();
    }
  },

  async load() {
    if (!this.data.cityId) return;
    // 先置 loading，避免首次进入时闪一下空状态
    this.setData({ loading: true });
    await api.ensureReady();
    this.loadBrands();
    try {
      const params = { cityId: this.data.cityId };
      if (this.data.keyword) params.keyword = this.data.keyword;
      const [rawStudios, follows] = await Promise.all([
        api.apiStudios(params),
        api.apiFollows(),
      ]);
      const followedIds = follows.map((f) => f.studio.id);
      const studios = rawStudios.map((s) => {
        const { brand, branch } = splitStudioName(s.name);
        const allStyles = Array.isArray(s.styles) ? s.styles : [];
        return {
          ...s,
          followed: followedIds.includes(s.id),
          // 头像仍显示名称首字符（中文名一眼可辨），分组字母由服务端按拼音算好
          avatarText: (s.name || "?").charAt(0),
          groupLetter: s.initial || (s.name || "?").charAt(0),
          brand,
          branch,
          styles: allStyles.slice(0, MAX_TAGS),
          extraStyles: Math.max(0, allStyles.length - MAX_TAGS),
        };
      });
      const { letters, sections } = buildSections(studios);
      // 扁平列表只留在实例上（关注状态回写用），视图只吃 sections，避免同一份数据被传两遍
      this._studios = studios;
      this.setData({ sections, letters, followedIds, loading: false }, () => {
        // 视图渲染完再量索引条，否则拿到的位置是旧的
        this.measureIndexBar();
      });
    } catch (e) {
      this.setData({ loading: false });
      toast(this, e.message);
    }
  },

  switchRegion(e) {
    const region = e.currentTarget.dataset.r;
    if (region === this.data.region) return;
    const filteredCities = (app.globalData.cities || []).filter(c => c.region === region);
    // 该地区暂无城市时给提示，避免切过去一片空白像 bug。
    // ⚠ 城市列表整个为空 = /api/cities 没拉到（服务端没起/连不上），
    // 与「海外没开放」是两回事，提示必须区分开。
    if (!filteredCities.length) {
      const cities = app.globalData.cities || [];
      wx.showToast({
        title: !cities.length
          ? "连不上 " + API_HOST
          : region === "OVERSEAS"
            ? "海外场馆暂未开放"
            : "暂无可选城市",
        icon: "none",
      });
      return;
    }
    const city = filteredCities[0];
    app.setCity(region, city.id);
    this.setData({ region, cityId: city.id, filteredCities });
    this.load();
  },

  selectCity(e) {
    const cityId = e.currentTarget.dataset.id;
    if (cityId === this.data.cityId) return;
    app.setCity(this.data.region, cityId);
    this.setData({ cityId });
    this.load();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
  },

  /**
   * 同城多店品牌 —— 这些品牌开了好几家分店，会员通常是通卡，
   * 所以单独给一条横滑入口，点进去直接看全部门店的合并课表。
   * 失败就静默：品牌是加分项，不该因为它报错挡住整个发现页。
   */
  async loadBrands() {
    try {
      const brands = await api.apiBrands(this.data.cityId);
      this.setData({ brands: brands || [] });
    } catch (e) {
      this.setData({ brands: [] });
    }
  },

  goReport() {
    wx.navigateTo({ url: "/pages/report/index" });
  },

  goBrand(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const b = this.data.brands[idx];
    if (!b) return;
    const ids = b.stores.map((s) => s.id).join(",");
    wx.navigateTo({
      url:
        "/pages/studio/weekly?ids=" +
        ids +
        "&title=" +
        encodeURIComponent(b.name),
    });
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
      const studios = (this._studios || []).map((s) =>
        s.id === id ? { ...s, followed: !isFollowed } : s,
      );
      this._studios = studios;
      const { sections } = buildSections(studios);
      this.setData({ followedIds, sections }, () => this.measureIndexBar());
      toast(this, isFollowed ? "已取消关注" : "已关注", "success");
    } catch (err) {
      toast(this, err.message);
    }
  },

  /* ───────────────────── 右侧字母索引条 ───────────────────── */

  /**
   * 一次性量出：① 索引条几何信息 ② 每个分组包裹层的「页面绝对纵坐标」。
   *
   * 为什么量 .sec-block 而不是 .sec-head：sec-head 是 sticky，
   * 一旦吸顶它的位置恒为状态栏下沿，据此算出的滚动目标 = 当前滚动位置，
   * 表现就是「往回拖不跟着动」。.sec-block 是普通块，位置永远真实。
   * 绝对坐标一次量好后，滑动过程中直接查表，不必反复发查询。
   */
  measureIndexBar(done) {
    if (this.data.letters.length < 2) {
      this._barRect = null;
      this._secTops = null;
      if (done) done();
      return;
    }
    const winH = this._winH || 0;
    const q = wx.createSelectorQuery();
    q.select(".index-bar").boundingClientRect();
    q.selectAll(".sec-block").boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec((res) => {
      const bar = res && res[0];
      const blocks = (res && res[1]) || [];
      const vp = res && res[2];

      // 索引条只信 height（translateY 不影响尺寸）：多数环境量到的 top 已含
      // translateY(-50%)，也有环境不含（此时 top 正好落在视口中线上），用这个特征判别
      if (bar && bar.height) {
        const centered = Math.abs(bar.top - winH / 2) < 1;
        this._barRect = {
          height: bar.height,
          top: centered ? (winH - bar.height) / 2 : bar.top,
        };
      }

      // 分组包裹层顺序与 sections/letters 一致，换算成页面绝对坐标
      if (blocks.length && vp) {
        const base = vp.scrollTop || 0;
        const map = {};
        this.data.letters.forEach((letter, i) => {
          if (blocks[i]) map[letter] = base + blocks[i].top;
        });
        this._secTops = map;
      }
      if (done) done();
    });
  },

  onIndexStart(e) {
    this._indexTouching = true;
    const y = this._touchY(e);
    if (y == null) return;

    // 先用上一次量到的位置，保证按下去立刻有反馈；再异步重量一次，
    // 校正键盘弹起等引起的视口变化，并按最新位置重算
    if (this._barRect) this.jumpToLetterAt(y);
    this.measureIndexBar(() => {
      if (this._barRect) this.jumpToLetterAt(y);
    });
  },

  onIndexMove(e) {
    if (!this._indexTouching) return;
    const y = this._touchY(e);
    if (y == null) return;
    this.jumpToLetterAt(y);
  },

  onIndexEnd() {
    this._indexTouching = false;
    if (this.data.activeLetter || this.data.indexTip) {
      this.setData({ activeLetter: "", indexTip: false });
    }
  },

  /** 页面隐藏时复位手势状态，免得回来气泡还挂着 */
  onHide() {
    this.onIndexEnd();
  },

  _touchY(e) {
    const t =
      e.touches && e.touches.length
        ? e.touches[0]
        : e.changedTouches && e.changedTouches.length
          ? e.changedTouches[0]
          : null;
    return t ? t.clientY : null;
  },

  /** 把触点纵坐标换算成字母：高亮它，并把列表滚到对应分组 */
  jumpToLetterAt(y) {
    const { letters, activeLetter, indexTip } = this.data;
    const rect = this._barRect;
    if (!letters.length || !rect || !rect.height) return;

    const step = rect.height / letters.length;
    const idx = Math.max(0, Math.min(letters.length - 1, Math.floor((y - rect.top) / step)));
    const letter = letters[idx];
    if (letter === activeLetter && indexTip) return;

    this.setData({ activeLetter: letter, indexTip: true });
    this.scrollToSection(letter);
  },

  /**
   * 滚到指定分组：优先用一次量好的绝对坐标（快且不受 sticky 影响），
   * 没量到就现测一次兜底。不用 pageScrollTo 的 selector 参数（要求基础库 ≥ 2.23.1），
   * 目标位置再减去状态栏高度，让吸顶标题正好停在状态栏下方。
   */
  scrollToSection(letter) {
    const bar = this.data.statusBarHeight || 0;
    const tops = this._secTops;
    const cached = tops ? tops[letter] : null;
    if (cached != null) {
      wx.pageScrollTo({ scrollTop: Math.max(0, cached - bar), duration: 0 });
      return;
    }
    const query = wx.createSelectorQuery();
    query.select("#" + anchorId(letter)).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((res) => {
      if (!res || !res[0] || !res[1]) return;
      const top = res[1].scrollTop + res[0].top - bar;
      wx.pageScrollTo({ scrollTop: Math.max(0, top), duration: 0 });
    });
  },

  /** 手指离开索引条后，随手一滚就清掉高亮和气泡（两个状态必须一起清，否则会剩一个空盒子） */
  onPageScroll() {
    if (!this._indexTouching && (this.data.activeLetter || this.data.indexTip)) {
      this.setData({ activeLetter: "", indexTip: false });
    }
  },
});
