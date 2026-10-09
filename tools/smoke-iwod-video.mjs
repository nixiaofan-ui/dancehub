/**
 * iWOD 课程预告视频（取址形态）烟测。
 *
 *   cd server && /usr/local/bin/node ../tools/smoke-iwod-video.mjs
 *
 * 为什么要有它：iWOD 的预告藏在 `/class/getClassDetail` 的 `videos` 里，而那个字段
 * 有两个坑，写错了**都不报错、只是详情页没有视频**（和菲体云那次一模一样的静默失败）：
 *   1. `videos` 是 **JSON 字符串**不是数组 —— 直接当数组遍历会得到 undefined；
 *   2. 数组里**视频和照片混着**（`isPhoto: true` 的是课程照片）—— 把 jpg 交给
 *      `<video>` 只会得到一块黑屏，还不报错。
 * 另外钉住「只存取址不存直链」：上游给的 mp4 看着是永久公开链接，但同一个对象里
 * 还带着 `fileId`，随时可能换成点播签名地址。
 */
const { parseVideoRef, pickVideoFromVideos, getIwodVideoUrl } = await import(
  "../server/src/services/iwod-video.js"
);
const { resolveScheduleVideoUrl } = await import("../server/src/services/schedule-video.js");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`,
  );
}

const REF = "iwod|wxa46dc234113caadd|14810|75383551";
const MP4 = "https://video.iwod.cn/05882b37vodsh1253881846/c8a3700b5001834822758494619/goiNNf4sFAAA.mp4";
const JPG = "https://cdn2.iwod.cn//mp_img/wxa46dc234113caadd/b_14810_u_5772160/1k4aimget_jcv9q.jpg";

/* ─── 取址格式解析 ─────────────────────────────────────────────────────── */

check("四段式取址 → 拆出 appId/boxId/classId", parseVideoRef(REF), {
  platform: "iwod",
  appId: "wxa46dc234113caadd",
  boxId: "14810",
  classId: "75383551",
});
check("平台前缀不对 → null（别拿去打上游）", parseVideoRef("fityun|a|b|c"), null);
check("只有三段 → null", parseVideoRef("iwod|a|b"), null);
check("缺 classId → null", parseVideoRef("iwod|app|14810|"), null);
check("空值 → null", parseVideoRef(""), null);

/* ─── videos 字段挑选（核心：视频 vs 照片） ─────────────────────────────── */

check("纯视频 → 取到 mp4", pickVideoFromVideos(JSON.stringify([{ isPhoto: false, src: MP4 }])), MP4);
check("⭐ 只有照片 → 空串（jpg 不能塞进 <video>）",
  pickVideoFromVideos(JSON.stringify([{ isPhoto: true, src: JPG }])), "");
check("照片在前、视频在后 → 跳过照片取视频",
  pickVideoFromVideos(JSON.stringify([{ isPhoto: true, src: JPG }, { isPhoto: false, src: MP4 }])), MP4);
check("⭐ videos 是 JSON 字符串（上游就这么给）→ 能解析",
  pickVideoFromVideos(`[{"isPhoto":false,"src":"${MP4}","fileId":"5001834822758494619"}]`), MP4);
check("空数组 → 空串", pickVideoFromVideos("[]"), "");
check("不是 JSON → 空串（上游改形状不要炸）", pickVideoFromVideos("[{bad json"), "");
check("给了数组对象而不是字符串 → 空串", pickVideoFromVideos([{ src: MP4 }]), "");
check("null / 空 → 空串", pickVideoFromVideos(null), "");
check("元素缺 src → 空串", pickVideoFromVideos(JSON.stringify([{ isPhoto: false }])), "");
check("相对路径不取（小程序里没有 base 可拼）",
  pickVideoFromVideos(JSON.stringify([{ isPhoto: false, src: "/video/a.mp4" }])), "");
check("m3u8 也算视频", pickVideoFromVideos(JSON.stringify([{ isPhoto: false, src: "https://v.x/a.m3u8" }])),
  "https://v.x/a.m3u8");
check("带查询串的 mp4 照样认", pickVideoFromVideos(JSON.stringify([{ isPhoto: false, src: "https://v.x/a.mp4?t=1" }])),
  "https://v.x/a.mp4?t=1");

/* ─── 回源 + 缓存（假 fetch） ───────────────────────────────────────────── */

let calls = [];
let nextBody = null;
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return { ok: true, status: 200, json: async () => nextBody };
};

const okBody = (videos) => ({ data: { code: 0, data: { videos } } });

nextBody = okBody(JSON.stringify([{ isPhoto: false, src: MP4 }]));
calls = [];
check("取址 → 回源拿到 mp4", await getIwodVideoUrl(REF), MP4);
check("请求打到 /class/getClassDetail", calls[0].includes("/class/getClassDetail"), true);
check("请求带上 classId", calls[0].includes("classId=75383551"), true);
check("请求带上 api_signature（否则上游不认）", calls[0].includes("api_signature="), true);

calls = [];
check("⭐ 缓存命中 → 不再回源", await getIwodVideoUrl(REF), MP4);
check("缓存确实拦住了第二次请求", calls.length, 0);

// 没有预告的课（iWOD 绝大多数是这样），空结果也要被缓存住
const REF_EMPTY = "iwod|wxa46dc234113caadd|14810|75383133";
nextBody = okBody("[]");
calls = [];
check("上游没有预告 → 空串", await getIwodVideoUrl(REF_EMPTY), "");
calls = [];
check("第二次还是空串", await getIwodVideoUrl(REF_EMPTY), "");
check("⭐ 空结果也被缓存（否则详情页会反复回源）", calls.length, 0);

// 上游抽风：不能抛异常，只能静默降级
const REF_ERR = "iwod|wxa46dc234113caadd|14810|999";
nextBody = { data: { code: -1, errMsg: "boom" } };
check("上游报错 → 空串而不是抛异常", await getIwodVideoUrl(REF_ERR), "");
globalThis.fetch = async () => {
  throw new Error("network down");
};
check("网络挂了 → 空串而不是抛异常", await getIwodVideoUrl("iwod|a|1|888"), "");

/* ─── 分派：iwod 前缀必须走 iWOD 那条路 ─────────────────────────────────── */

let dispatched = 0;
globalThis.fetch = async (url) => {
  dispatched++;
  calls.push(String(url));
  return { ok: true, status: 200, json: async () => okBody(JSON.stringify([{ isPhoto: false, src: MP4 }])) };
};
calls = [];
check("分派层：iwod 前缀 → 拿到地址", await resolveScheduleVideoUrl(REF_EMPTY + "1"), MP4);
check("分派层确实发起了回源", dispatched, 1);
check("分派层没有把取址当直链（URL 里是接口路径不是 pipe 串）",
  calls[0].includes("iwod%7C") || calls[0].includes("iwod|"), false);

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
