const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");
const { API_HOST } = require("../../utils/config");
const { onNavTop } = require("../../utils/scroll-top");
const CP = require("../../utils/city-picker-mixin");

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

/**
 * 把「同城多店品牌」在列表里收成一行。
 *
 * 之前列表是纯门店粒度：AB DANCE 绍兴店 / 剧场店 / 国际店 各占一行，同一个品牌
 * 连着刷屏，用户反馈「还是以分店的形式列出来」。品牌归属交给服务端
 * `/studios/brands`（连写名字、总店全名、行政区尾巴这些坑都在那边处理），
 * 前端只负责「用品牌行替换掉它的成员门店」。
 *
 * ⚠ 只在本次结果里命中 ≥2 家时才收：搜「绍兴」只命中 AB DANCE 绍兴店一家，
 * 不该把没命中的另外两家也拉进来充数。
 */
function mergeBrandRows(studios, brands) {
  const inResult = new Set(studios.map((s) => s.id));
  const ownerOf = new Map(); // studioId -> 品牌行
  for (const b of brands || []) {
    const stores = (b.stores || []).filter((s) => inResult.has(s.id));
    if (stores.length < 2) continue;
    const row = { brandName: b.name, stores, storeCount: stores.length };
    for (const s of stores) ownerOf.set(s.id, row);
  }
  if (!ownerOf.size) return studios;

  const rows = [];
  const done = new Set();
  for (const s of studios) {
    const owner = ownerOf.get(s.id);
    if (!owner) {
      rows.push(s);
      continue;
    }
    if (done.has(owner)) continue; // 品牌行只在其首店出现的位置插一次
    done.add(owner);
    rows.push(composeBrandRow(owner, s));
  }
  return rows;
}

/**
 * 分店名收尾清理：原始数据里带装饰性 emoji 和多余空格
 * （「临平店  🔽」），串成一行时特别扎眼。
 * 清完为空就退回原值 —— 宁可留个怪符号，也别把分店名擦没了。
 */
function tidyBranch(s) {
  const raw = String(s || "").trim();
  const t = raw.replace(/\s+/g, " ").replace(/[^\u4e00-\u9fa5A-Za-z0-9)）]+$/, "").trim();
  return t || raw;
}

/** 品牌行要保持门店行的字段形状，视图就不用为它单开一套模板 */
function composeBrandRow(owner, first) {
  return {
    id: "brand:" + owner.brandName,
    isBrand: true,
    brand: owner.brandName,
    // 「3 家分店」走 branch 的位置（虚色小字），和门店行排版一致
    branch: owner.storeCount + " 家分店",
    // 分店名串成一行，复用地址那行的省略号样式
    branchLine: owner.stores.map((s) => tidyBranch(s.branch || s.name)).join(" · "),
    avatarText: owner.brandName.charAt(0),
    // 分组字母沿用首店：服务端按拼音算好的，中文品牌名不会掉进「#」
    groupLetter: first.groupLetter,
    followed: false,
    storeIds: owner.stores.map((s) => s.id).join(","),
    // 舞种取首店：品牌各店舞种本来就不一样，合并反而糊
    styles: first.styles || [],
    extraStyles: first.extraStyles || 0,
  };
}

Page(
  Object.assign({}, CP.methods, {
  onNavTop,

  data: Object.assign({}, CP.data, {
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
  }),

  async onLoad() {
    const g = app.globalData;
    // 吸顶的分组标题要避开状态栏（自定义导航栏下顶部是系统状态栏）
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this._winH = info.windowHeight;
    this.setData(
      Object.assign(
        { statusBarHeight: info.statusBarHeight || 20 },
        this.syncCityView(g.region, g.cityId, g.cities || []),
      ),
    );
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
      this.setData(this.syncCityView(g.region, g.cityId, g.cities || []));
      this.load();
    }
  },

  async load() {
    if (!this.data.cityId) return;
    // 先置 loading，避免首次进入时闪一下空状态
    this.setData({ loading: true });
    await api.ensureReady();
    try {
      const params = { cityId: this.data.cityId };
      if (this.data.keyword) params.keyword = this.data.keyword;
      // 品牌接口失败不该挡住发现页 → 兜底空数组，最差退化成纯门店列表
      const [rawStudios, follows, brands] = await Promise.all([
        api.apiStudios(params),
        api.apiFollows(),
        api.apiBrands(this.data.cityId).catch(() => []),
      ]);
      const brandList = brands || [];
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
      // 多店品牌收成一行（顶部那条横滑品牌栏另有入口，这里只是别让同品牌刷屏）
      const rows = mergeBrandRows(studios, brandList);
      const { letters, sections } = buildSections(rows);
      // 扁平列表只留在实例上（关注状态回写用），视图只吃 sections，避免同一份数据被传两遍
      this._rows = rows;
      this.setData({ brands: brandList, sections, letters, followedIds, loading: false }, () => {
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
    app.setCity(region, city.id, "manual");
    this.setData(this.syncCityView(region, city.id, app.globalData.cities || []));
    this.load();
  },

  selectCity(e) {
    const cityId = e.currentTarget.dataset.id;
    if (cityId === this.data.cityId) return;
    app.setCity(this.data.region, cityId, "manual");
    this.applyCity(cityId);
  },

  /**
   * 城市被选中的统一出口：chip 和城市面板都走这里。
   * 必须同步 setData 的 cityId/hotCities，否则从面板选了个冷门城市，
   * chip 条上既不高亮也不出现，看着像没生效。
   */
  applyCity(cityId) {
    this.setData(this.syncCityView(this.data.region, cityId, this.data.cities));
    this.load();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
  },

  /**
   * 同城多店品牌 —— 这些品牌开了好几家分店，会员通常是通卡，
   * 所以单独给一条横滑入口，点进去直接看全部门店的合并课表。
   *
   * 数据已并入 load()：品牌既要撑起这条横滑栏，又要决定下面列表里哪些门店
   * 该收成一行，分两次请求会出现「横栏已经是新的、列表还是门店粒度」的中间态。
   */
  goReport() {
    wx.navigateTo({ url: "/pages/report/index" });
  },

  /** 自选组合：跨品牌自由挑门店一起看课 */
  goPick() {
    wx.navigateTo({ url: "/pages/studio/pick" });
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
        encodeURIComponent(b.name) +
        // 品牌的分店是系统列出来的、不是他挑的 → 进去只勾一家，别一上来铺满全屏
        "&first=1",
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
    const row = (this._rows || []).find((r) => String(r.id) === String(id));
    if (row && row.isBrand) {
      // 品牌行 → 连同全部分店进课表；分店是系统列出来的，进去只勾一家（first=1）
      wx.navigateTo({
        url:
          "/pages/studio/weekly?ids=" +
          row.storeIds +
          "&title=" +
          encodeURIComponent(row.brand) +
          "&first=1",
      });
      return;
    }
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
      const rows = (this._rows || []).map((s) =>
        !s.isBrand && s.id === id ? { ...s, followed: !isFollowed } : s,
      );
      this._rows = rows;
      const { sections } = buildSections(rows);
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
}));
