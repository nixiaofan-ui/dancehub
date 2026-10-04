/**
 * 舞种筛选条的公共实现。
 *
 * ⚠ 三个页面都在用，之前每个页面各抄了一份（首页课表 / 单店课表 / 我的-关注），
 *   算法一改就得改三处、漏一处就是「这个页面能筛、那个页面筛不动」。
 *   收敛到这里，页面只负责「我这一条数据属于哪些舞种」。
 *
 * 两种粒度都由同一个 labelsOf 抹平：
 *   - 按课筛（首页、单店课表）：一节课只有一个舞种 → [label]
 *   - 按店筛（我的-关注）：一家店教 Jazz+Kpop 就返回 ['Jazz','Kpop']，计数各投一票
 */
const { detectStyle, OTHER, DISPLAY_ORDER } = require("./dance-style.js");

/** 一节课 → 它的舞种标签；课名里认不出舞种的一律归「其它」，不会被悄悄筛掉 */
function styleOfCourse(courseName) {
  return detectStyle(courseName) || OTHER;
}

/** 「其它」不是真舞种，没有 DISPLAY_ORDER 位次，同课时一律排最后 */
const orderOf = (l) => (l === OTHER ? 999 : DISPLAY_ORDER.indexOf(l));

/**
 * 统计一批条目的舞种分布，产出筛选条要的数据。
 *
 * ⚠ prevActive 的两种「空」不是一回事，别合并：
 *   - null / undefined = 从没算过（首次进页面）→ 默认全选
 *   - []              = 用户点了「清除」→ 一个都不选，列表为空
 *   合并的后果：用户清除后一切换 tab 触发重载，筛选条又自己全勾上了。
 *
 * @param {any[]} items
 * @param {(item: any) => string[]} labelsOf 一个条目属于哪些舞种
 * @param {string[]} [prevActive] 上次勾选了哪些（null=首次）
 * @param {Set<string>} prevLabels 上次列表里出现过哪些舞种
 * @returns {{show: boolean, chips: Array<{label:string,count:number,on:boolean}>,
 *            active: string[], labels: Set<string>}}
 */
function buildStyleChips(items, labelsOf, prevActive, prevLabels) {
  const tally = new Map();
  items.forEach((i) => {
    new Set(labelsOf(i) || []).forEach((l) => tally.set(l, (tally.get(l) || 0) + 1));
  });
  const labels = new Set(tally.keys());

  // 只有一个舞种（或全都识别不出来）时不显示：没有选择余地的开关是噪音。
  // ⚠ active 必须回 null（「没在筛」）而不是 []（「用户清除了」）——
  //   回 [] 的话筛选条虽然藏起来了，过滤逻辑却会把课一节不留地全筛掉。
  if (tally.size < 2) {
    return { show: false, chips: [], active: null, labels };
  }

  const chips = [...tally.entries()]
    .map((p) => ({ label: p[0], count: p[1] }))
    .sort((a, b) => b.count - a.count || orderOf(a.label) - orderOf(b.label));

  // 保留上次勾选，剔掉这次列表里已经没有的舞种
  const active = [];
  (prevActive || []).forEach((l) => {
    if (tally.has(l)) active.push(l);
  });

  // 新冒出来的舞种要补选上。判据是「上一轮列表里见没见过」，不是「当前选没选」——
  // 后者会把用户刚取消的舞种又勾回来。
  // 不补的后果很隐蔽：勾上一家新分店，它带来的新舞种默认不勾 → 那家店的课一节都不
  // 显示，而门店 chip 上还写着它有课，用户只会以为数据坏了。
  // ⚠ 用户主动「清除」（prevActive=[]）时一个都不补 —— 那是他刚做的决定。
  if (prevLabels && prevLabels.size && prevActive && prevActive.length) {
    labels.forEach((l) => {
      if (!prevLabels.has(l) && active.indexOf(l) < 0) active.push(l);
    });
  }
  // 默认全选有两种情况：
  //   1. 首次进页面（prevActive 为 null）；
  //   2. 上次勾的舞种这次**一个都不在** —— 换了城市，或者今天这家店没排那几门课。
  //      不回全选的话，用户切进来看到一整页空白，而筛选条上他勾的那个舞种
  //      因为列表里已经没有、连 chip 都不显示了，「为什么空」根本看不出来。
  // ⚠ 用户主动「清除」（prevActive=[]）必须保住空态，不能被这条覆盖 ——
  //   `!prevActive` 为假、`prevActive.length` 为 0，正好把两种情况分开。
  if (!active.length && (!prevActive || prevActive.length)) {
    chips.forEach((c) => active.push(c.label));
  }

  const on = new Set(active);
  // 按 chip 顺序输出：补选的新舞种是 push 到末尾的，不重排的话
  // 调用方拿到的顺序会随操作历史漂移
  const ordered = chips.map((c) => c.label).filter((l) => on.has(l));
  return {
    show: true,
    chips: chips.map((c) => ({ ...c, on: on.has(c.label) })),
    active: ordered,
    labels,
  };
}

/**
 * 按当前勾选的舞种过滤。
 *
 * ⚠ active 为 null/undefined = 「没在筛」→ 原样返回；
 *   active 为 []            = 「用户清除了」→ 一条都不留。
 *   早期版本把两者都当成「不筛」，于是「清除」按钮点了跟没点一样。
 */
function filterByStyle(items, labelsOf, active) {
  if (active == null) return items;
  const on = new Set(active);
  return items.filter((i) => (labelsOf(i) || []).some((l) => on.has(l)));
}

/**
 * 「全选 / 清除」二合一按钮的新状态 —— 与分店条那颗按钮同一套行为。
 * 全选时它是「清除」（点了清空），否则是「全选」。
 */
function toggleAllActive(chips, allOn, key) {
  const k = key || "label";
  return allOn ? [] : (chips || []).map((c) => c[k]);
}

/** 当前是否全选（一个都没选时不算全选，否则清除态会被显示成全选态） */
function isAllOn(chips, active) {
  const on = active || [];
  return on.length > 0 && on.length === (chips || []).length;
}

module.exports = {
  OTHER,
  styleOfCourse,
  buildStyleChips,
  filterByStyle,
  toggleAllActive,
  isAllOn,
};
