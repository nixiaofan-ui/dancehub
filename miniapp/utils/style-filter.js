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
 * @param {any[]} items
 * @param {(item: any) => string[]} labelsOf 一个条目属于哪些舞种
 * @param {string[]} prevActive 上次勾选了哪些
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

  // 只有一个舞种（或全都识别不出来）时不显示：没有选择余地的开关是噪音
  if (tally.size < 2) {
    return { show: false, chips: [], active: [], labels };
  }

  const chips = [...tally.entries()]
    .map((p) => ({ label: p[0], count: p[1] }))
    .sort((a, b) => b.count - a.count || orderOf(a.label) - orderOf(b.label));

  // 保留上次勾选，剔掉这次列表里已经没有的舞种
  const active = (prevActive || []).filter((l) => tally.has(l));

  // 新冒出来的舞种要补选上。判据是「上一轮列表里见没见过」，不是「当前选没选」——
  // 后者会把用户刚取消的舞种又勾回来。
  // 不补的后果很隐蔽：勾上一家新分店，它带来的新舞种默认不勾 → 那家店的课一节都不
  // 显示，而门店 chip 上还写着它有课，用户只会以为数据坏了。
  if (prevLabels && prevLabels.size) {
    labels.forEach((l) => {
      if (!prevLabels.has(l) && active.indexOf(l) < 0) active.push(l);
    });
  }
  if (!active.length) chips.forEach((c) => active.push(c.label));

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

/** 按当前勾选的舞种过滤；没勾选（或全选）时原样返回 */
function filterByStyle(items, labelsOf, active) {
  if (!active || !active.length) return items;
  const on = new Set(active);
  return items.filter((i) => (labelsOf(i) || []).some((l) => on.has(l)));
}

module.exports = { OTHER, styleOfCourse, buildStyleChips, filterByStyle };
