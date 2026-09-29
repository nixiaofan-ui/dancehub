/**
 * 舞种识别（小程序端本地版）。
 *
 * ⚠ 这个文件与 server/src/services/dance-style.service.js 是同一套规则的两份拷贝
 *   （那边是 ESM，这里是小程序要的 CommonJS）。**改任一边都要同步改另一边**，
 *   否则「发现页说这家教 Jazz、课表筛选里却筛不出 Jazz」。
 *
 * 为什么前端要再算一遍：课表是按天整份拉回来的，按舞种过滤是纯函数，
 *   本地算就不用等云托管发版（部署链路经常滞后一两天）。
 *
 * 规则：按数组顺序匹配，先命中先返回（所以更具体的词要排前面，如 kpop 必须在 pop 之前）。
 */

const RULES = [
  // ── 街舞 ──
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
  { label: "芭蕾", keys: ["芭蕾", "ballet", "足尖", "英皇", "pbt", "基训", "变奏", "barre", "把杆"] },
  { label: "现代舞", keys: ["现代舞", "当代舞", "contemporary", "lyrical", "抒情"] },

  // ── 国标 / 社交舞 ──
  {
    label: "拉丁",
    keys: [
      "拉丁", "伦巴", "恰恰", "桑巴", "斗牛", "牛仔舞",
      "rumba", "cha cha", "chacha", "samba", "jive", "paso",
    ],
  },
  {
    label: "社交舞",
    keys: [
      "salsa", "bachata", "kizomba", "zouk", "tango", "探戈",
      "semba", "rueda", "casino", "swing", "balboa",
    ],
  },

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

/** 展示顺序：越靠前越「街舞」，用于标签排序的第二权重 */
const DISPLAY_ORDER = RULES.map((r) => r.label);

/** 认不出来的课归到这里，筛选时才不会漏掉一批课无处可去 */
const OTHER = "其它";

/**
 * 从单条课名解析舞种，识别不到返回 null
 * @param {string} courseName
 * @returns {string|null}
 */
function detectStyle(courseName) {
  if (!courseName) return null;
  const name = String(courseName).toLowerCase();
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i];
    for (let j = 0; j < rule.keys.length; j++) {
      if (name.indexOf(rule.keys[j]) >= 0) return rule.label;
    }
  }
  return null;
}

module.exports = {
  detectStyle: detectStyle,
  OTHER: OTHER,
  DANCE_STYLES: DISPLAY_ORDER,
  DISPLAY_ORDER: DISPLAY_ORDER,
};
