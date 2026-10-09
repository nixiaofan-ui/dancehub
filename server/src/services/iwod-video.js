/**
 * iWOD「课程预告视频」按需回源。
 *
 * ⚠ 这是 `Schedule.videoRef` 的第三种形态（`iwod|<appId>|<boxId>|<classId>`，取址）。
 *   另外两种见 services/schedule-video.js 的分派说明（菲体云取址 / 魔方直链）。
 *   调用方请走 schedule-video.js，别直接调本文件的函数。
 *
 * 背景（2026-10-09 逆向确认）：
 *   iWOD 的**课表接口 `/class` 里没有任何视频字段**（字段全集里只有 `pic` 封面和
 *   `coach_avatar`），所以「iWOD 没有课程预告」这个结论是错的 —— 预告在
 *   `GET /class/getClassDetail?classId=<本节课ID>` 的 `videos` 里，而且该接口在
 *   小程序端的**免登录接口白名单**里（`access_token=undefined` 即可调通）。
 *
 * ⚠ `videos` 是个 **JSON 字符串**而不是数组（上游就这么给），形如：
 *     `[{"isPhoto":false,"src":"https://video.iwod.cn/.../xxx.mp4","fileId":"..."}]`
 *   里面**既有视频也有照片**（`isPhoto: true` 的是课程照片，不是预告片），
 *   必须按 `isPhoto` + 扩展名双重判定，否则会把 jpg 塞进 `<video>` 得到一块黑屏。
 *
 * ⚠ 为什么不落直链：地址是腾讯云 COS 的公开对象（HEAD 实测 200 / video/mp4，
 *   无防盗链、URL 里也没有签名参数），看着像永久链接 —— 但没有 `Cache-Control`
 *   可佐证，而 `fileId` 的存在说明它随时可能换成点播签名地址。存「取址」而不是
 *   存 URL，即使上游哪天改成 1 小时签名，前端也不用改。
 *
 * 请求量：只对**用户真的打开详情页**的课回源（videoRef 非空才发），
 *   同一条课在缓存期内只回源一次，失败静默降级为空串。
 */
import crypto from "node:crypto";

const IWOD_HOST = "https://api2.iwod.cn";

/** 与 crawler/engine.js 的 iwodSignature 同一算法（签名时排除的保留字） */
const SIGN_EXCLUDE = new Set(["pfx", "partner_key", "sign", "key"]);

function iwodSignature(params, appId) {
  const qs = Object.keys(params)
    .filter((k) => !SIGN_EXCLUDE.has(k) && String(params[k]) !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHash("md5")
    .update(`${qs}&key=${appId}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

/** 缓存时长：拿到地址时。上游没有明确过期时间，留足余量即可 */
const TTL_MS = 50 * 60 * 1000;
/**
 * 「这节课没预告」的缓存时长。
 * ⚠ 比菲体云的 5 分钟长得多（这里 30 分钟）：iWOD 的课**绝大多数没有预告**
 * （实测 10-09 陆家嘴店 15 节里只有 3 节有真视频），空结果是常态而不是异常，
 * 缓存太短会让详情页这块反复回源。代价是商家刚上传的预告最多延迟 30 分钟可见。
 */
const EMPTY_TTL_MS = 30 * 60 * 1000;

const cache = new Map(); // videoRef -> { url, at }
const inflight = new Map(); // videoRef -> Promise，防同一节课并发重复回源

const VIDEO_EXT_RE = /\.(mp4|mov|m3u8|webm)(?:[?#]|$)/i;

/** `iwod|wxa46dc234113caadd|14810|75383133` → 各段；格式不对返回 null */
export function parseVideoRef(ref) {
  const parts = String(ref || "").split("|");
  if (parts.length !== 4) return null;
  const [platform, appId, boxId, classId] = parts;
  if (platform !== "iwod" || !appId || !classId) return null;
  return { platform, appId, boxId, classId };
}

/**
 * 从上游的 `videos` 字段里挑出**预告视频**的地址。
 * @param {unknown} raw 上游原样给的 `videos`（JSON 字符串）
 * @returns {string} 视频地址；没有 / 全是照片 / 解析不了 → ""
 */
export function pickVideoFromVideos(raw) {
  if (raw == null || raw === "") return "";
  let list;
  try {
    list = JSON.parse(String(raw));
  } catch {
    // 上游改了形状（比如直接给数组）不要炸，当没有预告
    return "";
  }
  if (!Array.isArray(list)) return "";
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    // 照片不是预告片：把 jpg 交给 <video> 只会得到一块黑屏
    if (it.isPhoto) continue;
    const src = String(it.src || it.url || "").trim();
    // 只认绝对地址 + 视频扩展名；相对路径在小程序里没有 base 可拼
    if (/^https?:\/\//i.test(src) && VIDEO_EXT_RE.test(src)) return src;
  }
  return "";
}

async function fetchOnce({ appId, boxId, classId }) {
  const params = {
    timezoneOffset: "-480",
    access_token: "undefined",
    user_id: "undefined",
    box_id: String(boxId || ""),
    language: "zh_CN",
    api_version: "3",
    appId,
    classId: String(classId),
  };
  params.api_signature = iwodSignature(params, appId);

  const resp = await fetch(
    `${IWOD_HOST}/class/getClassDetail?${new URLSearchParams(params).toString()}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        Referer: `https://servicewechat.com/${appId}/42/page-frame.html`,
      },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.json();
  const inner = body?.data;
  if (!inner || inner.code !== 0) {
    throw new Error(`code=${inner?.code} ${inner?.errMsg || ""}`);
  }
  return pickVideoFromVideos(inner?.data?.videos);
}

/**
 * 取某节课的预告视频地址。返回 "" 表示没有 / 取不到（调用方不要区分这两种）。
 * @param {string} videoRef Schedule.videoRef，例 `iwod|wxa46dc234113caadd|14810|75383133`
 * @returns {Promise<string>}
 */
export async function getIwodVideoUrl(videoRef) {
  const ref = parseVideoRef(videoRef);
  if (!ref) return "";

  const hit = cache.get(videoRef);
  if (hit) {
    const ttl = hit.url ? TTL_MS : EMPTY_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.url;
  }
  if (inflight.has(videoRef)) return inflight.get(videoRef);

  const task = (async () => {
    try {
      const url = await fetchOnce(ref);
      cache.set(videoRef, { url, at: Date.now() });
      return url;
    } catch (err) {
      // 静默降级：详情页少一块视频，不影响约课
      console.warn(`[iwod-video] ${videoRef} 回源失败：${err.message}`);
      cache.set(videoRef, { url: hit ? hit.url : "", at: Date.now() });
      return "";
    } finally {
      inflight.delete(videoRef);
    }
  })();
  inflight.set(videoRef, task);
  return task;
}
