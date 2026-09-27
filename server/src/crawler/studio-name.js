/**
 * 舞室展示名的组成规则（品牌 + 分店）。
 *
 * ── 为什么必须有这一层 ──
 * 爱舞功/舞十这类 SaaS 的课表接口只返回「宝安中心店」「大学城店」这种分店名，
 * 品牌名（如「CLAP dance studio」）不在课表接口里，只在品牌配置里。
 * 直接拿分店名入库会有两个后果：
 *   1. 用户看到「宝安中心店」根本不知道是哪家，而宝安中心只是个地铁站；
 *   2. 更严重：入库按店名匹配，7 个不同品牌的「大学城店」会被合并成同一条
 *      Studio 记录，它们的课全部混在一起（实测 41 个歧义名、62 家店被张冠李戴）。
 *
 * 因此统一命名：品牌名 + 分隔符 + 分店名。
 */

const SEP = "·";

/** 归一化：去掉空格和常见分隔符，用于判断分店名是否已含品牌名 */
function norm(s) {
  return String(s || "")
    .replace(/[\s·•・\-—_()（）【】]/g, "")
    .toLowerCase();
}

/**
 * 组成展示名。
 * @param {string} brand  品牌名（配置里的 config.studio.name）
 * @param {string} branch 分店名（接口返回，可能为空）
 */
export function composeStudioName(brand, branch) {
  const b = String(brand || "").trim();
  const br = String(branch || "").trim();
  if (!br) return b;
  if (!b) return br;
  // 分店名已经自带品牌（如「UC舞蹈工作室 旗舰店」）就不再重复拼
  if (norm(b) && norm(br).includes(norm(b))) return br;
  return `${b}${SEP}${br}`;
}

/** 从展示名里取出品牌名（复制去微信搜索时用品牌名命中率最高） */
export function brandOf(displayName) {
  return String(displayName || "").split(SEP)[0].trim();
}

export { SEP as STUDIO_NAME_SEP };
