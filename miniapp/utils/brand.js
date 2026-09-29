/**
 * 品牌归属计算（小程序端本地版）。
 *
 * ⚠ 为什么前端要再算一遍：服务端的 /studios/brands 要等云托管部署才生效，
 *   而部署链路经常滞后（2026-09-28 那次服务端停在旧版整整一天，老板一直以为
 *   是自己缓存 / 没重新编译）。门店名是前端本来就有的数据，聚类又是纯函数，
 *   所以干脆自己算 —— 传一次体验版就能看到合并结果，不再依赖发版节奏。
 *
 * ⚠ 这个文件与 server/src/lib/studio-name.js 是同一套算法的两份拷贝。
 *   改任一边都要同步改另一边，否则会出现「顶部品牌栏和列表不一致」。
 *   两边唯一的区别：这里是 CommonJS（小程序不支持 ESM），那边是 ESM。
 */

/** 尾部括号内容含这些字 → 那是分店名不是行政区 */
const BRANCH_WORD_RE = /[店校区分馆中心]/;

/** 「品牌·分店」里的分店名也可能是「品牌（分店）」 */
const DISTRICT_PAREN_RE = /\s*[（(]\s*([^）)]{2,4})\s*[）)]\s*$/;

/** 营销尾巴：「（点击有地图指引）」这种不能当分店名 */
const NOISE_RE =
  /[（(][^）)]*(?:地图|导航|预约|指引|营业|电话|微信|扫码|关注|点击)[^）)]*[）)]\s*$/;
const TRAILING_PAREN_RE = /\s*[（(][^）)]*[）)]\s*$/;

/** 分店名的结尾标志 */
const BRANCH_SUFFIX_RE = /(?:店|校区|分校)$/;

function cleanName(name, max) {
  const cap = max || 12;
  if (!name) return "";
  let s = String(name).trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(NOISE_RE, "").replace(TRAILING_PAREN_RE, "").trim();
    if (s === before) break;
  }
  if (!s) s = String(name).trim();
  if (s.length > cap) s = s.slice(0, cap) + "…";
  return s;
}

/** 剥掉抓取时拼上去的行政区尾巴：「XX舞蹈（武林店）（市拱墅）」→「XX舞蹈（武林店）」 */
function stripDistrictTag(name) {
  const raw = String(name || "").trim();
  const m = raw.match(DISTRICT_PAREN_RE);
  if (!m || BRANCH_WORD_RE.test(m[1])) return raw;
  return raw.slice(0, raw.length - m[0].length).trim() || raw;
}

/**
 * 「品牌·分店」/「品牌（分店）」→ { brand, branch }，没分隔符则 brand 为空。
 * ⚠ 括号不能优先于「·」：G-STEPS 那种名字末尾括号是城市，先按括号切会毁掉 39 家店。
 */
function splitBrandBranch(name) {
  if (!name) return { brand: "", branch: "" };
  const raw = stripDistrictTag(name);
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

/** 品牌归一 key：去掉空格/标点/大小写差异，「AB DANCE」和「AbDance」算同一个 */
function brandKey(brand) {
  return String(brand || "").replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, "").toLowerCase();
}

/** 品牌名尾巴上的分隔符、半个括号、行政区字眼都要去掉 */
function cleanBrandLabel(s) {
  const t = String(s || "").replace(/\s{2,}/g, " ").trim();
  return t.replace(/[\s\-|/｜·.、市区县省镇（(]+$/g, "").trim() || t;
}

/**
 * 连写门店名的所有合法切法：「AB DANCE剧场店」→ AB DANCE + 剧场店。
 * 单看一个名字无法确定切分点，所以全部列出来，交给「有没有兄弟门店共用」来投票。
 */
function candidateSplits(name) {
  const raw = String(name || "").trim();
  const tail = (raw.match(/[^\s（(]*$/) || [""])[0];
  if (!tail) return [];
  const out = [];
  for (let k = 2; k <= Math.min(6, tail.length); k++) {
    const branch = tail.slice(tail.length - k);
    const prefix = raw.slice(0, raw.length - branch.length).trim();
    if (BRANCH_SUFFIX_RE.test(branch)) {
      if (prefix.length >= 2) out.push({ prefix: prefix, branch: branch });
      continue;
    }
    // 分店名不以「店」结尾也允许，但前缀要更长 —— 否则「AB DANCE」会被切成「AB」+「DANCE」
    if (prefix.length >= 4) out.push({ prefix: prefix, branch: branch });
  }
  return out;
}

/**
 * 同城门店 → 品牌分组。只返回门店数 ≥2 的品牌。
 *
 * @param {{id:number,name:string}[]} studios 同城门店（可以是门店行，只要带 id/name）
 * @returns {{name:string, storeCount:number, stores:{id:number,name:string,branch:string}[]}[]}
 */
function buildBrandGroups(studios) {
  const list = studios || [];
  const groups = new Map(); // normKey -> { len, std, labels, stdLabels, members }
  const add = (prefix, studio, branch, std) => {
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
    if (std) {
      g.std = true;
      g.stdLabels.set(p, (g.stdLabels.get(p) || 0) + 1);
    }
    g.labels.set(p, (g.labels.get(p) || 0) + 1);
    if (!g.members.has(studio.id)) {
      g.members.set(studio.id, { id: studio.id, name: studio.name, branch: branch });
    }
  };

  for (const s of list) {
    const raw = stripDistrictTag(s.name);
    const parts = splitBrandBranch(raw);
    if (parts.brand) add(parts.brand, s, parts.branch, true);
    const splits = candidateSplits(raw);
    for (let i = 0; i < splits.length; i++) {
      add(splits[i].prefix, s, splits[i].branch, false);
    }
    // 本部：全名即品牌名（「猫宁舞蹈工作室」自己没切法，靠兄弟店来认领）
    // ⚠ 带括号的名字不算，否则会和连写切出的垃圾前缀撞在一起
    if (!/[（(]/.test(raw)) add(raw, s, "", true);
  }

  const usable = [];
  groups.forEach((g) => {
    if (g.members.size >= 2) usable.push(g);
  });
  // 覆盖门店数多的先挑 → 店家写清楚的优先 → 前缀长的优先
  usable.sort(
    (a, b) =>
      b.members.size - a.members.size ||
      Number(b.std) - Number(a.std) ||
      b.len - a.len,
  );

  const taken = {};
  const out = [];
  for (let i = 0; i < usable.length; i++) {
    const g = usable[i];
    const pool = g.stdLabels.size ? g.stdLabels : g.labels;
    const entries = [];
    pool.forEach((v, k) => entries.push([k, v]));
    entries.sort((a, b) => b[1] - a[1]);
    const label = cleanBrandLabel(entries[0][0]);

    const stores = [];
    g.members.forEach((m) => {
      if (taken[m.id]) return; // 已被覆盖更广的品牌认领
      taken[m.id] = 1;
      stores.push({ id: m.id, name: m.name, branch: m.branch || "总店" });
    });
    if (stores.length < 2) continue;
    out.push({ name: label, storeCount: stores.length, stores: stores });
  }
  out.sort((a, b) => b.storeCount - a.storeCount || String(a.name).localeCompare(String(b.name), "zh"));
  return out;
}

/**
 * 展示用：把「MAX POWER STUDIO（苏河湾店）」拆成主名 + 分店名。
 *
 * 为什么拆：整串名字用 32rpx/900 一股脑塞一行时，品牌名和「（苏河湾店）」一样重，
 * 长名还会把右侧按钮顶出卡片。拆成两级后主名吃掉视觉重量，分店名降级成辅助信息。
 *
 * ⚠ 只用于**前端排版**，与上面那套品牌归属算法（要和服务端保持一致的那份）无关。
 *
 * ⚠ 顺序很关键：先剥末尾的行政区尾巴（「（市秦淮）」），再看「·」,**最后**才看括号。
 *   旧版直接拿末尾括号切，于是 `G-STEPS·祥云小镇店（北京）` 被切成
 *   主名「G-STEPS·祥云小镇店」+ 分店名「北京」—— 末尾括号里是**城市不是分店**，
 *   39 家 G-STEPS 全被挂上「北京」这个假分店名（2026-09-29 老板在分店页看到的就是这个）。
 *   「品牌·分店」这种写法里分店名本来就在主名里，所以不再单独给分店标签。
 */
function splitStudioName(name) {
  const clean = stripDistrictTag(String(name || "").trim());
  const dot = clean.indexOf("·");
  if (dot >= 2) {
    return { brand: clean.replace(/[·\s]+$/, ""), branch: "" };
  }
  const m = clean.match(/^(.*?)\s*[（(]\s*([^）)]+?)\s*[)）]\s*$/);
  // 括号里得有分店字眼（店/校/区/分/馆/中心）才算分店名，
  // 否则可能只是「（杭州）」这样的城市尾巴，当成品牌名的一部分更安全。
  if (m && m[1].trim() && m[2].trim() && BRANCH_WORD_RE.test(m[2]) && !NOISE_RE.test(clean)) {
    return { brand: m[1].trim(), branch: m[2].trim() };
  }
  return { brand: clean, branch: "" };
}

/**
 * 取「分店名」—— 分店列表页每一行的标题。
 *
 * 与 splitStudioName 的区别：那个是给列表行排版用的（主名要保留分店信息），
 * 这个是只要分店名那一截（品牌已经写在页面标题里了）。
 *
 * ⚠ 同样必须「·」优先于括号，理由见 splitStudioName。
 * 取不出来时返回 ""，由调用方决定显示「总店」还是退回完整店名 —— 不在这里瞎猜。
 */
function branchOf(name) {
  const clean = stripDistrictTag(String(name || "").trim());
  const dot = clean.indexOf("·");
  if (dot >= 2) {
    const tail = clean.slice(dot + 1).replace(/^[\s·]+/, "").trim();
    if (tail) return tail;
  }
  const m = clean.match(/^(.*?)\s*[（(]\s*([^）)]+?)\s*[)）]\s*$/);
  if (m && m[1].trim() && m[2].trim() && BRANCH_WORD_RE.test(m[2]) && !NOISE_RE.test(clean)) {
    return m[2].trim();
  }
  return "";
}

module.exports = {
  buildBrandGroups: buildBrandGroups,
  splitBrandBranch: splitBrandBranch,
  splitStudioName: splitStudioName,
  branchOf: branchOf,
  stripDistrictTag: stripDistrictTag,
  cleanBrandLabel: cleanBrandLabel,
};
