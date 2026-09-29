Component({
  /**
   * 城市选择面板 —— 解决「城市太多，横滑找不到」。
   *
   * 三种找法并存，因为真实使用是三种场景：
   *   1) 热门城市：九宫格直接点，覆盖 80% 的人
   *   2) 搜：知道名字 → 汉字/全拼/首字母缩写都能中
   *   3) 翻：只知道大概是哪个音 → 右侧字母索引跳过去
   *
   * 数据是父页面传进来的全量城市（已在 globalData 缓存），组件不做请求，
   * 这样它既能挂发现页也能挂首页，且不重复拉接口。
   */
  properties: {
    visible: { type: Boolean, value: false },
    cities: { type: Array, value: [] },
    cityId: { type: null, value: null },
    region: { type: String, value: "CN" },
    locating: { type: Boolean, value: false },
    // 开启后，搜不到城市时不再只说「没这个城市」，而是给一条
    // 「就用「三亚」」的入口 —— 录课页要允许把还没接入的城市录进来。
    allowCustom: { type: Boolean, value: false },
  },

  data: {
    keyword: "",
    groups: [],
    letters: [],
    hot: [],
    result: null, // 搜索结果（null = 没在搜，展示分组）
    noHit: false,
    missName: "", // 没命中时用户输入的原词，给「直接用它」按钮当参数
    activeLetter: "",
    indexTip: false,
  },

  observers: {
    "visible, cities, cityId": function () {
      if (this.data.visible) this.rebuild();
    },
  },

  lifetimes: {
    attached() {
      this.rebuild();
    },
  },

  methods: {
    /**
     * 重算三组视图数据：热门 / 分组 / 字母条。
     * cities 服务端已按门店数排好（热门在前），这里切前 12 个当热门，
     * 其余全部进字母分组——注意热门城市也保留在分组里，
     * 否则有人习惯翻字母找「上海」会翻不到，以为是 bug。
     */
    rebuild() {
      const all = this.data.cities || [];
      const list = all.map((c) => ({ ...c, _letter: c.initial || "#" }));
      const hot = all.slice(0, 12);

      const bucket = new Map();
      for (const c of list) {
        if (!bucket.has(c._letter)) bucket.set(c._letter, []);
        bucket.get(c._letter).push(c);
      }
      const letters = [...bucket.keys()].sort((a, b) => {
        if (a === "#") return 1;
        if (b === "#") return -1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      this.setData({
        hot,
        letters,
        groups: letters.map((l) => ({ letter: l, cities: bucket.get(l) })),
      });
    },

    onInput(e) {
      const kw = (e.detail.value || "").trim().toLowerCase();
      this.setData({ keyword: e.detail.value || "" });
      if (!kw) {
        this.setData({ result: null, noHit: false, missName: "" });
        return;
      }
      const hit = (this.data.cities || []).filter((c) => {
        const name = c.name || "";
        // 汉字直接子串匹配；拼音那边同时试「全拼前缀」和「首字母缩写前缀」
        return (
          name.indexOf(kw) >= 0 ||
          (c.pinyin && c.pinyin.indexOf(kw) === 0) ||
          (c.abbr && c.abbr.toLowerCase().indexOf(kw) === 0)
        );
      });
      this.setData({
        result: hit,
        noHit: hit.length === 0,
        missName: hit.length === 0 ? (e.detail.value || "").trim() : "",
      });
    },

    clearKeyword() {
      this.setData({ keyword: "", result: null, noHit: false, missName: "" });
    },

    /**
     * 搜不到但页面允许库外城市：把用户输入的词原样抛给页面。
     * 录课页拿到后会切成手输模式并填好名字，用户不用再重新打一遍。
     */
    useCustom() {
      const name = String(this.data.missName || "").trim();
      if (!name) return;
      this.triggerEvent("custom", { name });
      this.close();
    },

    noop() {
      // 面板内部滚动要阻止冒泡到底层页面
    },

    close() {
      this.triggerEvent("close");
    },

    pick(e) {
      const id = e.currentTarget.dataset.id;
      const city = (this.data.cities || []).find((c) => c.id === id);
      if (!city) return;
      this.triggerEvent("select", { id: city.id, name: city.name });
      this.close();
    },

    tapLocate() {
      this.triggerEvent("locate");
    },

    // —— 右侧字母索引：按住滑动连续跳转，抬起后 0.6s 收起提示 ——
    onIndexStart(e) {
      this.jumpByTouch(e);
      this.setData({ indexTip: true });
    },
    onIndexMove(e) {
      this.jumpByTouch(e);
    },
    onIndexEnd() {
      const t = setTimeout(() => this.setData({ indexTip: false }), 600);
      this._tipTimer = t;
    },

    jumpByTouch(e) {
      const touch = e.touches[0];
      if (!touch) return;
      this.createSelectorQuery()
        .select(".ci-bar")
        .boundingClientRect((box) => {
          if (!box || !box.height) return;
          const letters = this.data.letters;
          // clientY 相对面板顶部 → 换算成第几个字母
          const ratio = Math.min(Math.max((touch.clientY - box.top) / box.height, 0), 0.999);
          const idx = Math.floor(ratio * letters.length);
          const letter = letters[idx];
          if (!letter || letter === this.data.activeLetter) return;
          this.setData({ activeLetter: letter }, () => {
            this.setData({ scrollInto: "cg-" + (letter === "#" ? "SHARP" : letter) });
          });
        })
        .exec();
    },
  },
});
