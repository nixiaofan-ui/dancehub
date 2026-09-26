/**
 * 舞种识别
 *
 * iWOD 抓下来的课名是自由文本（如「进阶jazz（A教室）（满5人开课）」），
 * 里面天然带着舞种信息。这里用关键词把课名归一成标准舞种标签，
 * 供发现页展示「这家店教什么」。
 *
 * 规则：
 * - 按数组顺序匹配，先命中先返回（所以更具体的词要排在前面，如 kpop 必须在 pop 之前）
 * - 同一条课名只取第一个命中的舞种，避免「jazz编舞」被算成两个
 */

const RULES = [
  // ── 街舞 ──
  // 具体舞种（长词/易混淆词优先）
  { label: "Kpop", keys: ["kpop", "k-pop", "k pop", "韩舞", "korea", "女团"] },
  { label: "HipHop", keys: ["hiphop", "hip-hop", "hip hop", "嘻哈", "hippop", "街舞"] },
  { label: "Jazz", keys: ["jazz", "爵士", "jaz"] },
  { label: "Swag", keys: ["swag"] },
  { label: "Popping", keys: ["popping", "poppin", "震感"] },
  { label: "Breaking", keys: ["breaking", "bboy", "b-boy", "霹雳"] },
  { label: "Locking", keys: ["locking", "lockin"] },
  { label: "Waacking", keys: ["waacking", "waack", "甩手"] },
  { label: "House", keys: ["house", "浩室"] },
  { label: "Urban", keys: ["urban", "choreography", "choreo"] },
  { label: "Vogue", keys: ["vogue", "voguing"] },
  { label: "Krump", keys: ["krump"] },
  { label: "Dancehall", keys: ["dancehall", "雷鬼"] },
  { label: "Afro", keys: ["afro", "非洲舞"] },
  { label: "水系", keys: ["水系"] },

  // ── 学院派 / 剧场舞 ──
  // 古典舞必须排在芭蕾之前：否则「古典舞基训」会被「基训」抢去算成芭蕾
  { label: "中国舞", keys: ["古典舞", "中国舞", "民族舞", "身韵", "汉唐", "胶州"] },
  // 「基训/软开/足尖」是芭蕾术语，且本平台以此命名的多为芭蕾基训课
  { label: "芭蕾", keys: ["芭蕾", "ballet", "足尖", "英皇", "pbt", "基训", "变奏", "barre", "把杆"] },
  { label: "现代舞", keys: ["现代舞", "当代舞", "contemporary", "lyrical", "抒情"] },

  // ── 国标 / 社交舞 ──
  { label: "拉丁", keys: ["拉丁", "伦巴", "恰恰", "桑巴", "斗牛", "牛仔舞", "rumba", "cha cha", "chacha", "samba", "jive", "paso"] },
  { label: "社交舞", keys: ["salsa", "bachata", "kizomba", "zouk", "tango", "探戈", "semba", "rueda", "casino", "swing", "balboa"] },

  // ── 其他专门舞种 ──
  { label: "踢踏", keys: ["踢踏", "tap dance", "tapdance"] },
  { label: "钢管舞", keys: ["钢管", "pole", "空中舞蹈", "aerial", "aerial hoop", "绸吊"] },
  { label: "高跟鞋", keys: ["heels", "高跟鞋"] },
  { label: "肚皮舞", keys: ["肚皮舞", "东方舞"] },

  // ── 课程类型（兜底，排在舞种之后）──
  { label: "MV编舞", keys: ["mv"] },
  { label: "编舞", keys: ["编舞", "成舞", "排舞", "routine"] },
  { label: "基本功", keys: ["基本功", "身体开发", "基础训练", "体能", "软开", "技巧", "拉伸"] },
];

/** 展示顺序：越靠前越"街舞"，用于标签排序的第二权重 */
const DISPLAY_ORDER = RULES.map((r) => r.label);

/**
 * 从单条课名解析舞种，识别不到返回 null
 * @param {string} courseName
 * @returns {string|null}
 */
export function detectStyle(courseName) {
  if (!courseName) return null;
  const name = String(courseName).toLowerCase();
  for (const rule of RULES) {
    if (rule.keys.some((k) => name.includes(k))) return rule.label;
  }
  return null;
}

/**
 * 从「课名 → 出现次数」的统计里挑出代表舞种
 * @param {Array<{courseName: string, count: number}>} rows
 * @param {number} limit 最多返回几个
 * @returns {string[]} 按「出现次数降序 → 街舞度」排序
 */
export function pickStyles(rows, limit = 4) {
  const tally = new Map();
  for (const row of rows || []) {
    const label = detectStyle(row.courseName);
    if (!label) continue;
    tally.set(label, (tally.get(label) || 0) + (row.count || 1));
  }
  return [...tally.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return DISPLAY_ORDER.indexOf(a[0]) - DISPLAY_ORDER.indexOf(b[0]);
    })
    .slice(0, limit)
    .map(([label]) => label);
}

export const DANCE_STYLES = DISPLAY_ORDER;
