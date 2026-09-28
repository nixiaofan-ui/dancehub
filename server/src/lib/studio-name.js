/**
 * 门店名清洗与「品牌·分店」拆分。
 *
 * 库里的名字三类混杂：
 *   1. 「品牌·分店」——爱舞功抓取时拼出来的，最干净
 *   2. 纯单店名——iWOD / 菲体云抓的老数据，没有品牌信息
 *   3. 带营销尾巴的单店名——「北京路店（点击有地图指引）」，分店里尤其多
 *
 * 多店视图要把门店挤进一枚 chip，名字必须短，所以统一在这里清洗，
 * 保证「发现页、门店 chips、课程卡片」三处看到的短名完全一致。
 */

/** 需要砍掉的噪音尾巴（含全文匹配不到的部分走正则降噪） */
const NOISE_RE =
  /[（(][^）)]*(?:地图|导航|预约|指引|营业|电话|微信|扫码|关注|点击)[^）)]*[）)]\s*$/;

/** 兜底：任何尾部括号内容都不该出现在短名里 */
const TRAILING_PAREN_RE = /\s*[（(][^）)]*[）)]\s*$/;

/**
 * 去掉展示噪音，得到干净的名字。
 * 「北京路店（点击有地图指引）」→「北京路店」
 */
export function cleanName(name, max = 12) {
  if (!name) return "";
  let s = String(name).trim();
  // 营销尾巴可能套多层括号，循环去掉为止（上限 3 层，防死循环）
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(NOISE_RE, "").replace(TRAILING_PAREN_RE, "").trim();
    if (s === before) break;
  }
  // 清洗过头了（整个名字都在括号里）就用原名
  if (!s) s = String(name).trim();
  if (s.length > max) s = s.slice(0, max) + "…";
  return s;
}

/**
 * 「品牌·分店」→ { brand, branch }；没有分隔符则 brand 为空。
 *
 * 两种分隔符都认：
 *   1. 「·」——爱舞功/嘉禾抓取时拼出来的标准格式
 *   2. 全角括号——老数据是「MAX POWER STUDIO（汶水路店）」这种，
 *      只认「·」会让这些同城分店聚不成品牌（发现页品牌条里查无此店，
 *      三家分店各自散在列表里）。2026-09-28 修。
 *
 * ⚠ 括号里是营销尾巴（「（点击有地图指引）」）时不能当分店名，
 *    否则会造出一个叫「点击有地图指引」的分店。
 * @param {string} name
 */
export function splitBrandBranch(name) {
  if (!name) return { brand: "", branch: "" };
  const raw = String(name).trim();
  const dot = raw.indexOf("·");
  if (dot > 0) {
    return { brand: raw.slice(0, dot).trim(), branch: cleanName(raw.slice(dot + 1)) };
  }
  const m = raw.match(/^(.*?)\s*[（(]\s*([^）)]+?)\s*[）)]\s*$/);
  if (m && m[1].trim() && m[2].trim() && !NOISE_RE.test(raw)) {
    return { brand: m[1].trim(), branch: cleanName(m[2]) };
  }
  return { brand: "", branch: cleanName(raw) };
}

/**
 * 多店视图里门店 chip / 课程卡片上的短标签。
 * 品牌已经在页面标题上了，这里只留分店名；没有品牌信息就用清洗后的全名。
 */
export function shortStudioLabel(name, max = 8) {
  const { brand, branch } = splitBrandBranch(name);
  // branch 已经是 cleanName 的结果，再收一次长度即可
  const base = branch || cleanName(name);
  if (base.length > max) return base.slice(0, max) + "…";
  // 极端情况：清洗后只剩品牌自己（分店名被括号吃光）
  return base || cleanName(brand, max);
}
