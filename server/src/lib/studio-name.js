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

/** 尾部括号里的内容长度上限：超过就不像区名了 */
const DISTRICT_PAREN_RE = /\s*[（(]\s*([^）)]{2,4})\s*[）)]\s*$/;

/** 出现在尾部括号里就说明这是分店名、不是行政区（「（天河岗顶店）」「（萧山店）」） */
const BRANCH_WORD_RE = /[店校区分馆中心]/;

/**
 * 剥掉抓取时拼上去的行政区尾巴：「SoulSister舞蹈工作室（武林店）（市拱墅）」→「…（武林店）」。
 *
 * 全国有 106 家店名带这个尾巴。不剥的话末尾括号被它占掉，
 * 真正的分店括号就拆不出来 —— 品牌变成「SoulSister舞蹈工作室（武林店）」，
 * 同城两家各成一个单店品牌，品牌条里永远查无此店。
 *
 * 判断依据：括号内容 ≤4 字且不含「店/校/区/分/馆/中心」。
 * 「（市余杭）」「（浦东）」「（族自治）」「（北京）」都剥；
 * 「（天河岗顶店）」「（汶水路店）」「（阳光店校区）」都保留。
 */
export function stripDistrictTag(name) {
  const raw = String(name || "").trim();
  const m = raw.match(DISTRICT_PAREN_RE);
  if (!m || BRANCH_WORD_RE.test(m[1])) return raw;
  return raw.slice(0, raw.length - m[0].length).trim() || raw;
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
 *
 * ⚠ 不要在这里加「无分隔符的 品牌+XX店」规则 —— 分店名长短不一，
 *    单看一个名字无法确定切分点：北京 MME街舞 的 7 家店会被切成
 *    「MME」「MM」「MME街」三个假品牌（比不聚合更乱）。
 *    这类名字走下面的 assignBrands（有兄弟可比对，才切得准）。
 * @param {string} name
 */
export function splitBrandBranch(name) {
  if (!name) return { brand: "", branch: "" };
  // 先剥行政区尾巴，否则末尾的「（市XX）」会顶掉真正的分店括号
  const raw = stripDistrictTag(name);
  // 「·」优先，但不能是「K·ONE DANCE 江南西旗舰店」这种——「·」前面只有 1 个字符时
  // 它是品牌名的一部分（K·ONE），切出来会得到一个叫「K」的品牌。
  // 品牌部分至少要 2 个字符才算分隔符。
  //
  // ⚠ 括号不能优先：「G-STEPS·祥云小镇店（北京）」末尾的括号是城市不是分店，
  //   先按括号切会得到 brand="G-STEPS·祥云小镇店"，39 家店的品牌整个消失（2026-09-28 踩过）
  const dot = raw.indexOf("·");
  if (dot >= 2) {
    return { brand: raw.slice(0, dot).trim(), branch: cleanName(raw.slice(dot + 1)) };
  }
  const m = raw.match(/^(.*?)\s*[（(]\s*([^）)]+?)\s*[）)]\s*$/);
  if (m && m[1].trim() && m[2].trim() && !NOISE_RE.test(raw)) {
    return { brand: m[1].trim(), branch: cleanName(m[2]) };
  }
  return { brand: "", branch: cleanName(raw) };
}

/**
 * 品牌归一 key：聚品牌时按它分组，避免「AB DANCE」「Ab Dance」「JM.艾达」「JM艾达」
 * 因为空格、大小写、标点差异算成两个牌子。
 * 只保留中英文和数字，其余（空格 - | / . ·）全部去掉。
 */
export function brandKey(brand) {
  return String(brand || "")
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, "")
    .toLowerCase();
}

/** 分店名的结尾标志 */
const BRANCH_SUFFIX_RE = /(?:店|校区|分校)$/;

/**
 * 一个「品牌 + 分店」连写、没有任何分隔符的门店名，单看它自己无法确定在哪切：
 * 「MME街舞通州北苑店」可能是「MME街舞 + 通州北苑店」也可能是「MME + 街舞通州北苑店」。
 *
 * 所以不猜，把所有合法切法都列出来（末尾 2-8 个非空格字符当分店名），
 * 交给 clusterByPrefix 按「有没有兄弟门店共用这个前缀」来挑。
 */
function candidateSplits(name) {
  const raw = String(name || "").trim();
  // 「·」不排除在分店名之外：「K·ONE DANCE 江南西旗舰店」里的「·」属于品牌名，
  //  排除它的话候选前缀最长只到「K·ONE DANCE 江南西」，三家店聚不到一起
  const tail = (raw.match(/[^\s（(]*$/) || [""])[0];
  if (!tail) return [];
  const out = [];
  // 上限 6 不是拍脑袋：分店名最长也就「北外滩来福士店」这个量级（6 字）。
  // 放宽到 8 时「PINK舞蹈工作室普陀店」能切出 prefix="PINK"，
  // 和「PINKDANCE宝山店」凑成一个叫「PINK」的品牌 —— 两家不一定是一回事。
  for (let k = 2; k <= Math.min(6, tail.length); k++) {
    const branch = tail.slice(tail.length - k);
    const prefix = raw.slice(0, raw.length - branch.length).trim();
    if (BRANCH_SUFFIX_RE.test(branch)) {
      if (prefix.length >= 2) out.push({ prefix, branch });
      continue;
    }
    // 分店名不以「店」结尾也允许（「ArtJAM Shanghai 静安」的「静安」是商圈不是店），
    // 但要求前缀 ≥4 字 —— 否则「AB DANCE」会被切成「AB」+「DANCE」这种假品牌
    if (prefix.length >= 4) out.push({ prefix, branch });
  }
  return out;
}

/**
 * 「武汉SUP舞蹈工作室-」「FSD舞社/」「丽珊舞馆|」——品牌名尾巴上的分隔符要去掉。
 * 顺带去掉尾巴上的「市/区/县/省/镇」：这些是抓取时拼的行政区，
 * 留在品牌名里会得到「S.Pink舞蹈 市」这种怪名字。
 */
export function cleanBrandLabel(s) {
  // 折叠连续空白：原始店名里有「D01  DANCE」这种双空格，展示时看着像错字
  const t = String(s || "").replace(/\s{2,}/g, " ").trim();
  // 末尾的半个括号也要去：切分点可能落在「（」上，留下「此间风雅舞蹈艺术空间(」
  return t.replace(/[\s\-|/｜·.、市区县省镇（(]+$/g, "").trim() || t;
}

/**
 * 同城品牌归属：把一堆同城门店名归成「品牌 + 分店」。
 *
 * 覆盖三种来源，统一用「候选前缀」投票：
 *   1. 有分隔符的（「品牌·分店」「品牌（分店）」）→ splitBrandBranch 直接给
 *   2. 连写的（「AB DANCE剧场店」「Hi-5 Dance文三店」）→ candidateSplits 枚举所有切法
 *   3. **门店全名本身** —— 这一条是 2026-09-28 补的：总店名字往往就是品牌名
 *      「猫宁舞蹈工作室」，它自己没有任何切法，光靠前两条永远进不了品牌，
 *      于是「猫宁舞蹈工作室·百家湖店」被判成单店品牌、两家合不起来。
 *      把全名也当候选前缀，兄弟店就能反过来认领它。
 *
 * 候选前缀只有被 ≥2 家店共用才算品牌；一家店可能同时命中
 * 「MME街舞」和更短的「MME」，按「覆盖门店数」从多到少贪心分配，
 * 覆盖多的先挑走 —— 否则同一家品牌的 7 家店会被拆成「MME」「MM」「MME街」三块。
 * 只比长度也会翻车：「RGM热血教室汉」比「RGM热血教室」长，恰好有两家店
 * （汉口店/汉阳店）共用，长的先挑走，武昌店就被剩在外面凑不成品牌。
 *
 * @param {{id:number,name:string}[]} studios 同城门店
 * @returns {Map<number, {brand:string, branch:string}>} 只含能归并的门店
 */
export function assignBrands(studios) {
  const groups = new Map(); // normKey -> { len, std, labels, members }
  const add = (prefix, id, branch, std) => {
    const p = cleanBrandLabel(prefix);
    const key = brandKey(p);
    if (!key) return;
    if (!groups.has(key)) {
      groups.set(key, {
        len: p.length,
        std: false,
        labels: new Map(),
        stdLabels: new Map(),
        members: new Map(),
      });
    }
    const g = groups.get(key);
    // std = 这个名字是「店里本来就写清楚的」（有分隔符，或全名即品牌），
    // 不是我们从连写名字里猜出来的切法
    if (std) {
      g.std = true;
      g.stdLabels.set(p, (g.stdLabels.get(p) || 0) + 1);
    }
    g.labels.set(p, (g.labels.get(p) || 0) + 1);
    if (!g.members.has(id)) g.members.set(id, branch);
  };

  for (const s of studios || []) {
    const raw = stripDistrictTag(s.name);
    const { brand, branch } = splitBrandBranch(raw);
    if (brand) add(brand, s.id, branch, true);
    for (const c of candidateSplits(raw)) add(c.prefix, s.id, c.branch, false);
    // 本部：全名即品牌名。
    // ⚠ 名字里带括号的不算 —— 「天舞华翎舞蹈 （总校）」归一化后是「天舞华翎舞蹈总校」，
    //   会和「天舞华翎舞蹈（总校5）」切出来的垃圾前缀撞成同一组，把品牌名抢成
    //   「天舞华翎舞蹈（总校」（2026-09-28 踩过）。带括号的名字走 splitBrandBranch 就够。
    if (!/[（(]/.test(raw)) add(raw, s.id, "", true);
  }

  const usable = [...groups.values()].filter((g) => g.members.size >= 2);
  // 覆盖门店数 → 是不是店家写清楚的 → 前缀长度。
  // 第二维必须有：「天舞华翎舞蹈（总校5）」连写切出的前缀比标准分隔符的结果更长，
  // 只比长度的话猜的那个会赢，品牌名就变成「天舞华翎舞蹈（总校」
  usable.sort(
    (a, b) =>
      b.members.size - a.members.size ||
      Number(b.std) - Number(a.std) ||
      b.len - a.len,
  );

  const taken = new Set();
  const result = new Map();
  for (const g of usable) {
    // 展示名取出现最多的写法（同一品牌的不同门店写法可能差一个空格）。
    // 优先用店里写清楚的那种写法 —— 猜出来的切法可能带着半个括号或半个分店名
    const pool = g.stdLabels.size ? g.stdLabels : g.labels;
    const label = cleanBrandLabel([...pool.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    for (const [id, branch] of g.members) {
      if (taken.has(id)) continue; // 已被覆盖更广的前缀认领
      taken.add(id);
      // 本部没有分店短名，给个「总店」占位，否则品牌卡上会显示「XX 等」前面空一格
      result.set(id, { brand: label, branch: branch || "总店" });
    }
  }
  return result;
}

/** @deprecated 用 assignBrands（它把「有分隔符」和「连写」两条路合一了） */
export function clusterByPrefix(studios) {
  return assignBrands(studios);
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
