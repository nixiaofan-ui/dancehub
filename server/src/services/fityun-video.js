/**
 * 菲体云「课程预告视频」按需回源。
 *
 * ⚠ 这是 `Schedule.videoRef` 的**其中一种**形态（`fityun|机构ID|排课ID` 这种「取址」）。
 *   另一种是上游直接给的永久直链（魔方约课），不需要回源。
 *   调用方请走 services/schedule-video.js 的分派，别直接调本文件的函数。
 *
 * 背景（2026-09-29 逆向确认）：菲体云的课表接口只在有预告视频的课上打
 * `has_video = 1`，**不带地址**；真正的播放地址要另打
 * `GET /tuancourse/scheduleappointinfo?scheduleid=<排课ID>`（请求头只要 orgid，
 * 免登录），响应里 `info.course.video_url` 就是腾讯云点播的 mp4 直链。
 *
 * ⚠ 三个必须记住的约束：
 *   1. **地址会过期**：`?t=<unix秒>` 是签名有效期，实测只给 1 小时。所以绝不能落库
 *      （库里存的是 `fityun|<机构ID>|<排课ID>` 这样的「取址」，见 Schedule.videoRef），
 *      必须在用户打开详情页时才现取。这也是为什么这里有一层 50 分钟的进程内缓存 ——
 *      比签名寿命短 10 分钟，避免边界上发出去一个已经失效的链接。
 *   2. **详情页是热路径**：门店热门课会被反复打开。只对有预告的课（videoRef 非空）
 *      才发请求，且同一条排课在缓存期内只回源一次。
 *   3. **失败要安静**：上游抖动、视频被商家删掉、签名变了……都不该让课程详情页报错。
 *      取不到就返回空串，前端把「课程预告」整块藏掉即可。
 *
 * 另一个已知边界：`/tuancourse/scheduleappointinfo` 对**已结束**的课返回的
 * `has_video` 仍是 1、地址也还在，所以历史课也能看到预告，不需要特判。
 */
const FITYUN_HOSTS = [
  "https://xiaochengxu-v3-api.fityun.cn",
  "https://xiaochengxu-edu-api-hz.fityun.cn",
];

/** 上游签名 1 小时；缓存留 10 分钟余量 */
const TTL_MS = 50 * 60 * 1000;
/** 取不到时不要把这个「空」记太久，商家可能刚上传完 */
const EMPTY_TTL_MS = 5 * 60 * 1000;

const cache = new Map(); // videoRef -> { url, at }
const inflight = new Map(); // videoRef -> Promise，防同一节课并发重复回源

/** `fityun|11058641|34103272` → { platform, orgId, scheduleId }；格式不对返回 null */
export function parseVideoRef(ref) {
  const parts = String(ref || "").split("|");
  if (parts.length !== 3) return null;
  const [platform, orgId, scheduleId] = parts;
  if (!platform || !orgId || !scheduleId) return null;
  return { platform, orgId, scheduleId };
}

async function fetchOnce(orgId, scheduleId) {
  let lastErr = null;
  for (const host of FITYUN_HOSTS) {
    const url = `${host}/tuancourse/scheduleappointinfo?scheduleid=${encodeURIComponent(
      scheduleId,
    )}`;
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
          orgid: String(orgId),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
      const body = await resp.json();
      if (body?.status !== 0) {
        lastErr = new Error(`status=${body?.status} ${body?.info || ""}`);
        continue;
      }
      const course = body?.info?.course;
      if (!course) return { url: "", host };
      // has_video=0 说明商家把预告撤了；地址字段一起清掉，别拿旧的
      if (Number(course.has_video) !== 1) return { url: "", host };
      return { url: String(course.video_url || ""), host };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("无法获取菲体云课程详情");
}

/**
 * 取某节课的预告视频地址。返回 "" 表示没有 / 取不到（调用方不要区分）。
 * @param {string} videoRef Schedule.videoRef，例 `fityun|11058641|34103272`
 * @returns {Promise<string>}
 */
export async function getFityunVideoUrl(videoRef) {
  const ref = parseVideoRef(videoRef);
  if (!ref) return "";
  if (ref.platform !== "fityun") return "";

  const hit = cache.get(videoRef);
  if (hit) {
    const ttl = hit.url ? TTL_MS : EMPTY_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.url;
  }
  if (inflight.has(videoRef)) return inflight.get(videoRef);

  const task = (async () => {
    try {
      const { url } = await fetchOnce(ref.orgId, ref.scheduleId);
      cache.set(videoRef, { url, at: Date.now() });
      if (!url) {
        console.warn(`[fityun-video] ${videoRef} 上游未给地址（可能商家已撤回）`);
      }
      return url;
    } catch (err) {
      // 静默降级：详情页少一块视频，不影响约课
      console.warn(`[fityun-video] ${videoRef} 回源失败：${err.message}`);
      cache.set(videoRef, { url: hit ? hit.url : "", at: Date.now() });
      return "";
    } finally {
      inflight.delete(videoRef);
    }
  })();
  inflight.set(videoRef, task);
  return task;
}
