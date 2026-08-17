import { config } from "../config.js";

const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

/**
 * 根据关键词搜索课程预告视频（MVP：YouTube Data API v3 优先）
 * 未配置 YOUTUBE_API_KEY 或搜索失败时返回空数组，不抛出异常。
 */
export async function searchCourseVideo({ keyword }) {
  if (!config.youtube.apiKey) return [];
  if (!keyword) return [];

  try {
    const url =
      YOUTUBE_SEARCH_URL +
      "?part=snippet" +
      "&type=video" +
      "&maxResults=6" +
      "&order=relevance" +
      "&q=" +
      encodeURIComponent(keyword) +
      "&key=" +
      encodeURIComponent(config.youtube.apiKey);

    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) {
      console.warn(`[dancehub] youtube search failed: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data.error) {
      console.warn(`[dancehub] youtube api error: ${data.error.message}`);
      return [];
    }

    return (data.items || []).map((item) => {
      const sn = item.snippet || {};
      const thumb = sn.thumbnails || {};
      const t = thumb.medium || thumb.high || thumb.default || {};
      return {
        videoId: item.id?.videoId || "",
        title: sn.title || "",
        description: sn.description || "",
        thumbnail: t.url || "",
        publishedAt: sn.publishedAt || "",
        channelTitle: sn.channelTitle || "",
        platform: "YOUTUBE",
        url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : "",
      };
    });
  } catch (err) {
    console.warn(`[dancehub] youtube search error: ${err.message}`);
    return [];
  }
}
