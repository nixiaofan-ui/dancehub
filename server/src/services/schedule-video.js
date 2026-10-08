/**
 * 把 `Schedule.videoRef` 解析成一个可以直接播放的地址。
 *
 * videoRef 是个自由文本列，目前有两种形态，取决于上游给的是什么：
 *
 *   1. **取址**（形如 `fityun|11058641|34103272`）—— 菲体云。
 *      上游只给「这节课有预告」的标记，真正的地址要另打一个接口，而拿到的是
 *      腾讯云点播**签名链接，签名 1 小时就过期**。落库等于存死链，所以库里只存
 *      「去哪儿取」，用户打开详情页时才现换一张新签名 —— 见 fityun-video.js，
 *      那里另有一层 50 分钟的进程内缓存兜住详情页这条热路径。
 *
 *   2. **直链**（形如 `https://media.yqdicloud.com/2026/10/07/<hash>.mp4`）—— 魔方约课。
 *      上游直接给公开、不过期的 mp4（HEAD 实测 `Cache-Control: max-age=93312000`
 *      ≈ 3 年），没有签名也没有过期，**直接落库即可，不存在回源问题**。
 *
 * 两者对前端是同一件事：拿到一个能塞进 `<video src>` 的字符串，拿不到就是空串。
 * 分派规则刻意用「看起来像 URL 就直接用」而不是维护平台白名单 ——
 * 以后再有平台给永久直链，不用回来改这里。
 *
 * ⚠ 前缀必须严格匹配 `http://` / `https://`：videoRef 是自由文本列，历史/脏数据里
 *   什么都可能出现，宽松匹配会把莫名其妙的值当成地址丢给 `<video>` 去报错。
 */
import { getFityunVideoUrl } from "./fityun-video.js";

const DIRECT_URL_RE = /^https?:\/\//i;

/** 这个 videoRef 是不是「一条现成的直链」（而不是需要回源的取址） */
export function isDirectVideoUrl(videoRef) {
  return DIRECT_URL_RE.test(String(videoRef || "").trim());
}

/**
 * @param {string|null} videoRef Schedule.videoRef
 * @returns {Promise<string>} 可直接播放的地址；取不到 / 没有预告时返回空串
 *   （调用方不要区分「没有」和「取不到」，前端一律隐藏整块）
 */
export async function resolveScheduleVideoUrl(videoRef) {
  const ref = String(videoRef || "").trim();
  if (!ref) return "";
  if (isDirectVideoUrl(ref)) return ref;
  // 非直链一律当菲体云的取址处理；getFityunVideoUrl 自己会对不认识的前缀返回空串
  return getFityunVideoUrl(ref);
}
