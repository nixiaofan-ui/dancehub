const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");
const { API_HOST } = require("../../utils/config");
const { onNavTop } = require("../../utils/scroll-top");
const CP = require("../../utils/city-picker-mixin");
const { buildBrandGroups, splitStudioName } = require("../../utils/brand");
const { locateCity, getOrigin } = require("../../utils/locate");
const { sortByDistance, llOf } = require("../../utils/geo");
const { goToCoach } = require("../../utils/coach-nav");

/** 「#」组没法直接当元素 id，映射成一个合法的锚点值 */
const anchorId = (letter) => "sec-" + (letter === "#" ? "SHARP" : letter);

/** 卡片上最多平铺几家任教门店，多出来的收成「+N」 */
const MAX_COACH_STUDIOS = 4;

/** 老师卡片副标题：任教几家店 + 课量 */
function coachSub(g) {
  const n = g.studioCount || (g.studios ? g.studios.length : 0);
  const where = n > 1 ? n + " 家店" : g.studios && g.studios[0] ? g.studios[0].short : "";
  const cnt = g.upcoming
    ? "近期 " + g.upcoming + " 节"
    : g.totalCourses
      ? "历史 " + g.totalCourses + " 节"
      : "";
  return [where, cnt].filter(Boolean).join(" · ");
}

/** 卡片上最多平铺几个舞种标签，多出来的收成「+N」 */
const MAX_TAGS = 3;

/** 没定到行政区的门店在筛选条上的档位名（真实区名不会叫这个，不会撞） */
const UNLABELED = "未标注";

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
    /**
     * 「按距离」开关。默认按名称排（带右侧字母索引）。
     * ⚠ 关着时绝不碰定位权限 —— 授权弹窗必须由「用户点了按距离」这个动作触发。
     */
    nearFirst: false,
    // 按距离排完后没能算出距离的店还有几家：要写出来，否则用户以为排序坏了
    unknownCount: 0,
    activeLetter: "",
    indexTip: false,
    statusBarHeight: 20,
    followedIds: [],
    loading: false,
    brands: [],
    /**
     * 搜索的命中范围：null = 全国（默认）。
     *
     * 为什么搜索不再跟着城市走：用户知道舞室名、但不一定知道它在哪个城市，
     * 「先切城市再搜」等于让人猜。现在默认全国搜，命中哪几个城市由
     * cityCounts 列出来，点一下才收窄（写进这个字段）。
     */
    searchCityId: null,
    cityCounts: [],
    hitTotal: 0,
    /**
     * 行政区筛选条。
     * ⚠ 覆盖率不是 100%（北京 31% / 杭州 51% / 上海 41%）：库里 address 长期为空，
     * 区名只能从回源上游补的地址和店名尾巴抽。抽不到的店**归到「未标注」chip 里**，
     * 不藏起来 —— 藏了用户会以为筛出来的是全部，实际漏了一大半。
     */
    districtChips: [],
    showDistrictBar: false,
    // 用户点了「清除」：列表空着是他自己选的，空态不能说成「没搜到」
    districtCleared: false,
    // 已被全选 → 右侧按钮显示「清除」；清除了就是空选，一个区都不留
    districtAllOn: true,
    unlabeledCount: 0,
    /** 本次结果是跨城的：卡片要带城市标签，且不做同城品牌合并 */
    globalMode: false,
    /**
     * 同城搜不到、但全国有命中（服务端算好回传）。
     * 「杭州搜 T-rex」就是这种：那家店挂在北京，同城页显示 0 结果，
     * 不说一句的话用户只会以为我们没收录。
     */
    crossCity: null,
    /** WXML 不能拼字符串，城市列表先在 JS 里拼好 */
    crossCityText: "",
    /**
     * 老师搜索结果（只在有关键词时出现）。
     * 一组 = 一个名字；组内是各家门店，**同名不合并** —— 详情见服务端注释：
     * 我们没法证明两家店的 Ken 是同一个人，合并了用户会约错人。
     *
     * ⚠ 排布上在门店结果**之后**：搜店名的人不想先被一排老师卡片挡住，
     *   而搜老师名时门店多半没命中，往下就是唯一的结果区（顶上有跳转条）。
     */
    coachGroups: [],
    /** 教练块的副标题（门店 0 命中时要说明一下为什么只有老师） */
    coachTip: "同名多店不合并，按门店自己判断",
    /** 同城搜不到老师、但全国有（服务端算好回传） */
    coachCrossCity: null,
    coachCrossText: "",
    /** 老师结果所属城市名（标题上要写明「北京的教练」，否则跨城重名无从判断） */
    coachCityName: "",
    /** 品牌条副标题：搜索态只说命中的分店，别说成「全部分店」 */
    brandSub: "一次看完全部分店",
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
    const kw = (this.data.keyword || "").trim();
    // 有关键词时默认全国搜（searchCityId 非空 = 用户已收窄到某个城市）；
    // 没有关键词就是「浏览某城市的门店列表」，此时才需要 cityId。
    const scopeId = kw ? this.data.searchCityId : this.data.cityId;
    const globalMode = !!kw && !scopeId;
    if (!kw && !scopeId) return;
    // 先置 loading，避免首次进入时闪一下空状态
    this.setData({ loading: true, globalMode });
    await api.ensureReady();
    try {
      const params = {};
      if (kw) params.keyword = kw;
      if (scopeId) {
        params.cityId = scopeId;
      } else {
        // 全国搜索：服务端限量返回，并额外回「每个城市命中几家」
        params.limit = 200;
        params.withCityCounts = 1;
      }
      // 教练搜索同批发出去：用户搜的是「一个名字」，门店和老师两个维度一起回，
      // 比先看到一堆店、再想起来还能搜老师顺畅。
      // ⚠ 只要有关键词就发，不能要求「先选了城市」：发现页搜索默认就是全国搜
      // （scopeId 为空），写成 kw && scopeId 的话，教练请求一次都不会发出去，
      // 搜索框写着「搜索舞室 / 教练名称」却永远只回门店 —— 就是这个 bug。
      // 城市口径：用户收窄过就用收窄的城市，否则用当前城市；服务端在本城
      // 0 命中时会自动放宽到全国（回 nationwide=true），不用前端操心。
      const coachCity = scopeId || this.data.cityId || 0;
      const coachPromise = kw
        ? api.apiCoachSearch(kw, coachCity).catch(() => null)
        : Promise.resolve(null);

      // 品牌接口失败不该挡住发现页 → 兜底空数组，最差退化成纯门店列表
      const [res, follows, coachRes] = await Promise.all([
        api.apiStudios(params),
        api.apiFollows(),
        coachPromise,
      ]);
      // 全国搜索回的是 { items, cityCounts, total }，城市内搜索回的是数组
      const rawStudios = Array.isArray(res) ? res : res.items || [];
      const cityCounts = Array.isArray(res) ? [] : res.cityCounts || [];
      const hitTotal = Array.isArray(res) ? rawStudios.length : res.total || 0;
      // 同城 0 结果但全国有 → 服务端会把跨城命中一并回传（见 studio.routes.js）
      const cc = Array.isArray(res) ? null : res.crossCity || null;
      const crossCityText = cc
        ? (cc.cities || []).slice(0, 4).map((c) => `${c.name} ${c.count}`).join(" · ")
        : "";
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
          // 跨城结果必须标明城市，否则「AB DANCE 绍兴店」看着像就在本城
          cityName: (s.city && s.city.name) || "",
          styles: allStyles.slice(0, MAX_TAGS),
          extraStyles: Math.max(0, allStyles.length - MAX_TAGS),
        };
      });
      // 品牌归属前端自己算：服务端 /studios/brands 要等云托管发版才生效，
      // 而门店名本来就在手上、聚类又是纯函数 —— 本地算就不受发版节奏牵制。
      // ⚠ 一律按**本次结果**算，搜索态也一样：早期搜索态是沿用上一次全城那份品牌表
      //   （当时的顾虑是「顶部品牌栏不该跟着关键词变」），代价是搜「Jazz」时顶部
      //   挂着一排一家店都没命中的连锁品牌，点进去全是别的分店 —— 搜什么就该看到什么。
      // ⚠ 跨城结果不做品牌合并：「上海 AB DANCE」和「杭州 AB DANCE」
      // 收成一行只会让人以为它们通卡。
      let brandList = [];
      if (!globalMode) {
        brandList = buildBrandGroups(studios);
        // 只有浏览态才退回服务端那份全城品牌表。搜索态宁可不显示品牌条 ——
        // 把没命中的品牌兜回来，正是这次要修掉的东西。
        if (!brandList.length && !this.data.keyword) {
          brandList = await api.apiBrands(scopeId).catch(() => []);
        }
      }
      // 多店品牌收成一行（顶部那条横滑品牌栏另有入口，这里只是别让同品牌刷屏）
      this.syncDistrictChips(studios);
      // 筛选条每次勾选都要按新口径重算视图，原始列表和品牌表留在实例上复用
      this._studios = studios;
      this._brandList = brandList;
      const view = this.buildRows(this.applyDistrictFilter(studios));
      const coaches = this.buildCoachGroups(coachRes, coachCity);
      // 一家店都没命中、却有人名命中时，标题上要说一句：否则用户看到光秃秃的
      // 教练卡片，会以为是门店列表没加载出来。
      const coachTip =
        coaches.groups.length && view.sections.length === 0
          ? "没有匹配的舞室，以下是命中的教练"
          : "同名多店不合并，按门店自己判断";
      this.setData(
        {
          brands: brandList,
          sections: view.sections,
          letters: view.letters,
          followedIds,
          cityCounts,
          hitTotal,
          crossCity: cc,
          crossCityText,
          coachGroups: coaches.groups,
          coachCrossCity: coaches.crossCity,
          coachCrossText: coaches.crossText,
          coachCityName: coaches.cityName,
          coachTip,
          brandSub: this.data.keyword ? "只看这次搜到的分店" : "一次看完全部分店",
          loading: false,
        },
        () => {
          // 视图渲染完再量索引条，否则拿到的位置是旧的
          this.measureIndexBar();
        },
      );
    } catch (e) {
      this.setData({ loading: false });
      toast(this, e.message);
    }
  },

  /**
   * 老师搜索结果 → 卡片视图。
   * WXML 里不能拼字符串、也不能调方法，展示文案一律在这里算好。
   */
  buildCoachGroups(res, cityId) {
    // 全国兜底：同城没搜到，服务端放宽到全国回来的结果 → 卡片必须标城市，
    // 否则「雪霏 · MAX POWER」看着像就在本城，点进去才发现要跨城。
    const nationwide = !!(res && res.nationwide);
    const groups = (res && res.groups ? res.groups : []).map((g) => ({
      name: g.name,
      avatarUrl: g.avatarUrl || "",
      initial: (g.name || "?").charAt(0),
      sub: coachSub(g),
      // 跨城结果才显示；同城结果写城市是噪音
      cityLabel: nationwide ? (g.cityNames || []).slice(0, 2).join(" / ") : "",
      // 跳老师主页要用**这位老师所在**的城市（全国模式下各组可能不同城）
      cityId: g.cityId || cityId || 0,
      // ⚠ 门店条只留店名，不带日期：卡片一行塞不下「店名 · 09-30 有课」，
      // 而且这信息对「判断是不是同一个人」没有帮助。具体哪天有课挪到
      // 教练页（那里有整块地方按日期列出）。这里只用颜色区分
      // 「近期有课」和「只在历史里出现过」，扫一眼就知道哪家现在能去。
      studios: (g.studios || []).slice(0, MAX_COACH_STUDIOS).map((s) => ({
        studioId: s.studioId,
        short: nationwide && s.cityName ? `${s.cityName} · ${s.short}` : s.short,
        hot: !!s.nextDate,
      })),
      extraStudios: Math.max(0, (g.studios || []).length - MAX_COACH_STUDIOS),
    }));
    const cc = res && res.crossCity ? res.crossCity : null;
    const cities = this.data.cities || app.globalData.cities || [];
    const city = cities.find((c) => c.id === cityId);
    // 点卡片跳老师主页要用**这次搜索的城市**：用户可能收窄到了别的城市
    this._coachCityId = cityId || 0;
    return {
      groups,
      crossCity: cc,
      crossText: cc
        ? (cc.cities || [])
            .slice(0, 3)
            .map((c) => `${c.name} ${c.count}`)
            .join(" · ")
        : "",
      cityName: nationwide ? "全国" : city ? city.name : "",
    };
  },

  /** 老师卡片 → 老师主页（未来两周的课 + 任教门店） */
  goCoachResult(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const g = this.data.coachGroups[idx];
    if (!g) return;
    // 全国兜底的结果各组不同城 → 用组自己的城市，不能统一用搜索城市
    goToCoach(g.name, g.cityId || this._coachCityId || this.data.cityId);
  },

  /**
   * 跳到教练结果区。
   *
   * 为什么需要这条：教练排在门店之后，而一次搜索可能回 200 家门店 —— 没有入口的话
   * 老师结果实际上等于不存在（没人会往下翻两百行）。所以只要两批结果都有，
   * 就在结果区顶部留一句「另命中 N 位教练」。
   */
  jumpToCoaches() {
    const q = wx.createSelectorQuery();
    q.select("#coach-block").boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec((res) => {
      if (!res || !res[0] || !res[1]) return;
      const top = res[1].scrollTop + res[0].top - (this.data.statusBarHeight || 0);
      wx.pageScrollTo({ scrollTop: Math.max(0, top), duration: 200 });
    });
  },

  /** 本城没这位老师、别处有 → 切到命中最多那座城市再看 */
  goCoachCrossCity() {
    const cc = this.data.coachCrossCity;
    const first = cc && cc.cities && cc.cities[0];
    if (!first) return;
    const patch = this.syncCityView(this.data.region, first.cityId, this.data.cities);
    app.setCity(this.data.region, first.cityId, "manual");
    this.setData(Object.assign({ searchCityId: first.cityId }, patch));
    this.load();
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
    const patch = this.syncCityView(this.data.region, cityId, this.data.cities);
    // 换城市就把「按距离」关掉：手上那个定位点是上一个城市的，
    // 拿它给新城市的店排距离，排出来的顺序是错的，而界面上完全看不出来
    if (this.nearFirst) {
      this.nearFirst = false;
      this.origin = null;
      patch.nearFirst = false;
      patch.unknownCount = 0;
    }
    // 搜索状态下切城市 = 把搜索范围收窄到这个城市。
    // 否则带关键词的请求根本不传 cityId，用户会以为「切了城市没反应」。
    if (this.data.keyword) patch.searchCityId = cityId;
    this.setData(patch);
    this.load();
  },

  /** 全国搜索结果顶部那条城市条：点一下收窄到该城市，再点一下取消 */
  tapHitCity(e) {
    const id = Number(e.currentTarget.dataset.id);
    this.setData({ searchCityId: this.data.searchCityId === id ? null : id });
    this.load();
  },

  clearSearchCity() {
    if (!this.data.searchCityId) return;
    this.setData({ searchCityId: null });
    this.load();
  },

  /**
   * 城市条上的「📍 定位」：不用先展开城市面板。
   * 面板里的「用当前位置」也走这里（mixin 的 onPickLocate 会优先调页面的 tapLocate）。
   */
  async tapLocate() {
    if (this.data.locating) return;
    this.setData({ locating: true });
    try {
      const r = await locateCity({ useCache: false });
      if (r.code === "ok" && r.city) {
        const cities = app.globalData.cities || [];
        app.setCity(r.city.region, r.city.id, "locate");
        this.setData(this.syncCityView(r.city.region, r.city.id, cities));
        if (this.data.keyword) this.setData({ searchCityId: r.city.id });
        this.load();
        wx.showToast({ title: "已定位到" + r.city.name, icon: "none" });
        return;
      }
      wx.showToast({
        title:
          r.code === "denied"
            ? "没给定位权限，可手动选城市"
            : r.code === "no-match"
              ? "你所在的城市还没接入"
              : "定位失败，可手动选城市",
        icon: "none",
      });
    } finally {
      this.setData({ locating: false, cityPickerVisible: false });
    }
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
    // 关键词没了，城市收窄也该一起解掉 —— 否则回到列表态还盯着某个城市
    this.setData({
      keyword: "",
      searchCityId: null,
      cityCounts: [],
      hitTotal: 0,
      crossCity: null,
      crossCityText: "",
      coachGroups: [],
      coachCrossCity: null,
      coachCrossText: "",
    });
    this.load();
  },

  /**
   * 行政区筛选条。
   *
   * 抽不到区的店放进「未标注」这一档并且**默认带上**：
   * 它们本来就在同城列表里，悄悄剔除会让用户以为「海淀区只有 12 家」，
   * 而实际还有一百多家只是我们没定到区。数字摆出来，让他自己决定看不看。
   */
  syncDistrictChips(studios) {
    const tally = new Map();
    let unlabeled = 0;
    studios.forEach((s) => {
      const d = s.district || "";
      if (!d) {
        unlabeled += 1;
        return;
      }
      tally.set(d, (tally.get(d) || 0) + 1);
    });
    // 一个区都没有（也没未标注的）→ 不给筛选条
    if (!tally.size && !unlabeled) {
      // ⚠ 必须是 null（没在筛）而不是 []（用户清除了）：条收起来了还按「清除」
      //   去过滤，同城列表会一家都不剩
      this.activeDistricts = null;
      this.setData({ districtChips: [], showDistrictBar: false, unlabeledCount: 0 });
      return;
    }
    const chips = [...tally.entries()]
      .map((p) => ({ label: p[0], count: p[1] }))
      .sort((a, b) => b.count - a.count);
    if (unlabeled) chips.push({ label: UNLABELED, count: unlabeled });

    // 只有一个可选项时也没必要给开关
    if (chips.length < 2) {
      // ⚠ 必须是 null（没在筛）而不是 []（用户清除了）：条收起来了还按「清除」
      //   去过滤，同城列表会一家都不剩
      this.activeDistricts = null;
      this.setData({ districtChips: [], showDistrictBar: false, unlabeledCount: unlabeled });
      return;
    }
    const known = new Set(chips.map((c) => c.label));
    // ⚠ 两种「空」要分开：从未筛过（null）→ 全选；用户点了「清除」（[]）→ 一个不留。
    //   混在一起的话，清除后一搜或者一切城市，筛选条又自己全勾上了。
    let active = [];
    if (this.data.keyword || this.activeDistricts == null) {
      // 搜索态一律放弃上次勾的区：搜「trex」时若还挂着「朝阳」，命中的店会被
      // 悄悄筛掉，用户只会以为这家店没收录。
      active = chips.map((c) => c.label);
    } else {
      active = this.activeDistricts.filter((l) => known.has(l));
    }
    this.activeDistricts = active;

    const on = new Set(active);
    this.setData({
      districtChips: chips.map((c) => ({ ...c, on: on.has(c.label) })),
      showDistrictBar: true,
      districtAllOn: active.length > 0 && active.length === chips.length,
      districtCleared: Array.isArray(active) && active.length === 0,
      unlabeledCount: unlabeled,
    });
  },

  /**
   * ⚠ active 为 null = 没在筛；为 [] = 用户清除了 → 一家都不留。
   * 早期写法把 [] 也当成「不筛」，于是「清除」点了跟没点一样，列表纹丝不动。
   */
  applyDistrictFilter(studios) {
    const active = this.activeDistricts;
    if (active == null) return studios;
    const on = new Set(active);
    return studios.filter((s) => on.has(s.district || UNLABELED));
  },

  tapDistrictChip(e) {
    const label = e.currentTarget.dataset.label;
    const active = new Set(this.activeDistricts || []);
    if (active.has(label)) {
      if (active.size === 1) return toast(this, "至少保留一个区域");
      active.delete(label);
    } else {
      active.add(label);
    }
    this.activeDistricts = [...active];
    const chips = this.data.districtChips || [];
    this.setData({
      districtChips: chips.map((c) => ({ ...c, on: active.has(c.label) })),
      districtAllOn: active.size > 0 && active.size === chips.length,
      districtCleared: false,
      ...this.buildRows(this.applyDistrictFilter(this._studios || [])),
    });
  },

  /** 全选 / 清除 二合一，与分店条、舞种条同款 */
  tapAllDistricts() {
    const chips = this.data.districtChips || [];
    const allOn = this.data.districtAllOn;
    const active = allOn ? [] : chips.map((c) => c.label);
    this.activeDistricts = active;
    this.setData({
      districtChips: chips.map((c) => ({ ...c, on: active.indexOf(c.label) >= 0 })),
      districtAllOn: !allOn,
      districtCleared: allOn,
      ...this.buildRows(this.applyDistrictFilter(this._studios || [])),
    });
  },

  /**
   * 门店 → 视图行（品牌合并 + 字母分组）。
   * 抽出来是因为筛选条每次勾选都要重算一遍，和 load() 里那段必须完全一致，
   * 复制一份迟早会两边不一致（一边合品牌一边不合）。
   */
  buildRows(studios) {
    const globalMode = this.data.globalMode;
    // 按距离排时**不做品牌归并**：品牌行是聚合出来的，本身没有坐标，排了只会
    // 让它沉到底下、把旗下分店甩在前面，比不聚合还乱。这里直接平铺单店。
    if (this.nearFirst && this.origin) {
      const r = sortByDistance(studios, this.origin, (s) => llOf(s));
      this._rows = r.list;
      // 整段当一个 section、letters 置空 → 右侧索引条自动收起（它要求 ≥2 个字母）
      return {
        sections: [{ letter: "", studios: r.list }],
        letters: [],
        unknownCount: r.unknownCount,
      };
    }
    const rows = globalMode ? studios : mergeBrandRows(studios, this._brandList || []);
    const built = buildSections(rows);
    this._rows = rows;
    return { sections: built.sections, letters: built.letters, unknownCount: 0 };
  },

  /**
   * 发现页「按距离」。
   * 拿不到定位就静默退回按名称排 —— 不弹错、不纠缠，用户没授权本来就是常态。
   */
  async tapNearFirst() {
    if (this.data.nearFirst) {
      this.nearFirst = false;
      this.origin = null;
      this.setData({
        nearFirst: false,
        ...this.buildRows(this.applyDistrictFilter(this._studios || [])),
      });
      return;
    }
    const origin = await getOrigin({ ask: true });
    if (!origin) {
      toast(this, "没拿到定位，可在系统设置里开启后再试");
      return;
    }
    this.origin = origin;
    this.nearFirst = true;
    this.setData({
      nearFirst: true,
      ...this.buildRows(this.applyDistrictFilter(this._studios || [])),
    });
  },

  /**
   * 点「全国还有 N 家」：放开城市限定重搜。
   * 只在这一次把 searchCityId 清空，cityId（浏览城市）不动 ——
   * 用户可能只是想看看这家店在哪，看完还要回本城列表。
   */
  goCrossCity() {
    this.setData({ searchCityId: null, crossCity: null, crossCityText: "" });
    this.load();
  },

  /**
   * 品牌行箭头 → 分店列表。
   * 品牌行把同城多店收成了一行，单店关注按钮随之消失；这里把它的成员门店
   * 交出去，由 branches 页摊平并提供逐店关注。
   *
   * 门店对象直接从 this._rows 拿（发现页本来就拉过全城列表），
   * 顺手塞进 globalData 让目标页少一次接口往返。
   */
  goBranches(e) {
    const id = e.currentTarget.dataset.id;
    const row = (this._rows || []).find((r) => String(r.id) === String(id));
    if (!row || !row.storeIds) return;
    const stores = row.stores || [];
    app.globalData.brandStores = stores;
    wx.navigateTo({
      url:
        "/pages/studio/branches?ids=" +
        row.storeIds +
        "&name=" +
        encodeURIComponent(row.brand || row.id.replace("brand:", "")),
    });
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
