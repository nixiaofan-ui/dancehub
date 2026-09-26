import { pinyin } from "pinyin-pro";

/**
 * 舞室列表的「通讯录式」排序
 *
 * 发现页要按首字母分组展示、并在右侧提供字母索引条，所以每家舞室必须能算出
 * 一个稳定的「分组字母」和一个「组内排序键」：
 *   - 英文开头 → 首字母大写即分组字母，组内按名称（小写）排
 *   - 中文开头 → 用拼音：首字的拼音首字母做分组，整名拼音做组内排序键
 *   - 数字 / 符号开头 → 一律归入「#」组，且该组固定排在所有字母之后
 *
 * 分组字母随名称走，故用 Map 按名称缓存；舞室总量在几百家量级，缓存不构成负担。
 */

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 排序时忽略名称最前面的装饰符号（「· 」「-」「【」之类），避免整组跑偏
const LEADING_NOISE = /^[\s\-–—_·.、,，:：;；'"“”‘’()（）[\]【】{}<>《》|/\\]+/;

/** 无法归入 A-Z 的一律进这组（数字、符号、生僻字等） */
const OTHER_GROUP = "#";

const cache = new Map();

function toPinyin(text, pattern) {
  const opts = { toneType: "none", type: "array" };
  if (pattern) opts.pattern = pattern;
  const out = pinyin(text, opts);
  return (Array.isArray(out) ? out : [out]).join("").toLowerCase();
}

/** 计算单个名称的分组字母与组内排序键 */
export function nameMeta(rawName) {
  const name = String(rawName ?? "").trim();
  const cached = cache.get(name);
  if (cached) return cached;

  const head = name.replace(LEADING_NOISE, "").charAt(0);
  let initial = OTHER_GROUP;
  let sortKey = name.toLowerCase();

  if (head && HAN.test(head)) {
    // 整个名称转拼音，保证同名不同店（如「麦田舞蹈…（A店）/（B店）」）能挨在一起
    sortKey = toPinyin(name);
    const firstLetter = toPinyin(head, "first");
    initial = /^[a-z]$/.test(firstLetter) ? firstLetter.toUpperCase() : OTHER_GROUP;
  } else if (head && /[a-zA-Z]/.test(head)) {
    initial = head.toUpperCase();
  }

  const meta = { initial, sortKey };
  cache.set(name, meta);
  return meta;
}

/** 分组字母比较：「#」固定垫底，其余按 A-Z */
export function compareInitial(a, b) {
  if (a === b) return 0;
  if (a === OTHER_GROUP) return 1;
  if (b === OTHER_GROUP) return -1;
  return a < b ? -1 : 1;
}

/** sort() 用的比较器，要求元素已带 initial / _sortKey */
function compareStudio(a, b) {
  const byInitial = compareInitial(a.initial, b.initial);
  if (byInitial !== 0) return byInitial;
  if (a._sortKey !== b._sortKey) return a._sortKey < b._sortKey ? -1 : 1;
  return (a.id || 0) - (b.id || 0);
}

/**
 * 给一批舞室补上 initial（分组字母）并按首字母排序。
 * 返回值会剥掉内部排序键，可直接回给客户端。
 */
export function sortStudiosByName(studios) {
  return studios
    .map((s) => {
      const meta = nameMeta(s.name);
      return { ...s, initial: meta.initial, _sortKey: meta.sortKey };
    })
    .sort(compareStudio)
    .map(({ _sortKey, ...rest }) => rest);
}
