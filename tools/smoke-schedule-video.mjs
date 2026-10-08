/**
 * 视频地址解析层烟测 —— `Schedule.videoRef` 有两种形态，必须都能解对。
 *
 *   cd server && /usr/local/bin/node ../tools/smoke-schedule-video.mjs
 *
 * 为什么要有它：videoRef 现在同时装两种东西（见 services/schedule-video.js）——
 *   · 菲体云的「取址」`fityun|机构|排课`（签名 1 小时过期，必须现取）
 *   · 魔方约课的永久 mp4 直链（直接就能播）
 * 分派写错的两种后果都很隐蔽：把直链当取址 → 详情页永远没有视频（parseVideoRef
 * 嫌它没有 3 段，静默返回空）；把取址当直链 → `<video>` 拿到一个 `fityun|1|2`
 * 的字符串，前端一块黑屏还不报错。两种都不抛异常，只能靠断言钉住。
 *
 * 另外钉住「三处列宽必须一致」—— 这是本项目的惯犯错误（schema / ensure-schema /
 * migrations 各写一份，忘了同步就只改到一半）。
 */
import { readFileSync } from "node:fs";

const { resolveScheduleVideoUrl, isDirectVideoUrl } = await import(
  "../server/src/services/schedule-video.js"
);

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`,
  );
}

/* ─── 假 fetch：只为菲体云那条回源路径准备 ──────────────────────────────── */

let calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 0,
      info: { course: { has_video: 1, video_url: "https://vod.example.com/signed.mp4?t=1" } },
    }),
  };
};

/* ─── 空值：一律空串，调用方不用区分「没有」和「取不到」 ─────────────────── */

check("null → 空串", await resolveScheduleVideoUrl(null), "");
check("undefined → 空串", await resolveScheduleVideoUrl(undefined), "");
check("空串 → 空串", await resolveScheduleVideoUrl(""), "");
check("只有空格 → 空串", await resolveScheduleVideoUrl("   "), "");

/* ─── 形态一：永久直链（魔方约课）→ 原样返回，且**一次请求都不发** ───────── */

const DIRECT = "https://media.yqdicloud.com/2026/10/07/aedc83a8e21c4e57948eba9e8f1369cc.mp4";
calls = [];
check("魔方直链 → 原样返回", await resolveScheduleVideoUrl(DIRECT), DIRECT);
check("⭐ 直链不发任何上游请求（这就是它比菲体云省事的地方）", calls.length, 0);
check("两侧空格被 trim", await resolveScheduleVideoUrl(`  ${DIRECT}  `), DIRECT);

/* ─── 形态二：菲体云取址 → 走回源换一张新签名 ───────────────────────────── */

calls = [];
check(
  "菲体云取址 → 回源拿到签名地址",
  await resolveScheduleVideoUrl("fityun|11058641|34103272"),
  "https://vod.example.com/signed.mp4?t=1",
);
check("回源确实发了请求", calls.length, 1);
check("回源 URL 带上排课 ID", calls[0].includes("scheduleid=34103272"), true);

// 认识不了的前缀：当取址处理，但 fityun-video 会自己挡掉，不能抛错也不能发请求
calls = [];
check("不认识的前缀 → 空串（不抛错）", await resolveScheduleVideoUrl("weird|a|b"), "");
check("不认识的前缀不发请求", calls.length, 0);
calls = [];
check("两段式脏值 → 空串", await resolveScheduleVideoUrl("fityun|11058641"), "");

/* ─── 直链判定必须严格（前缀 + 协议白名单） ─────────────────────────────── */

check("http:// 也算直链", isDirectVideoUrl("http://cdn.x/a.mp4"), true);
check("大小写不敏感", isDirectVideoUrl("HTTPS://cdn.x/a.mp4"), true);
check("相对路径不算", isDirectVideoUrl("/static/a.mp4"), false);
check("裸域名不算（少了协议）", isDirectVideoUrl("media.yqdicloud.com/a.mp4"), false);
check("ftp 不算", isDirectVideoUrl("ftp://cdn.x/a.mp4"), false);
check("javascript: 不算（videoRef 是自由文本列，别把脏数据当地址）",
  isDirectVideoUrl("javascript:alert(1)"), false);
check("协议出现在中间不算", isDirectVideoUrl("fityun|a|https://x"), false);

/* ─── 列宽三处同步 + 「真的够长吗」 ──────────────────────────────────────── */

const readRoot = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const schemaPrisma = readRoot("../server/prisma/schema.prisma");
const ensureSchema = readRoot("../server/src/lib/ensure-schema.js");
const migration = readRoot(
  "../server/prisma/migrations/20261008160000_widen_schedule_video_ref/migration.sql",
);

const schemaLen = Number(/videoRef\s+String\?\s+@db\.VarChar\((\d+)\)/.exec(schemaPrisma)?.[1]);
const ensureLen = Number(/const VIDEO_REF_LEN = (\d+)/.exec(ensureSchema)?.[1]);
const migrationLen = Number(/`videoRef` VARCHAR\((\d+)\)/.exec(migration)?.[1]);

check("schema.prisma 里声明了列宽", Number.isFinite(schemaLen), true);
check("三处列宽一致（schema / ensure-schema / migration）", [schemaLen, ensureLen, migrationLen], [512, 512, 512]);
check("当初必须加宽：实测直链比旧的 64 还长", DIRECT.length > 64, true);
check("加宽后的列宽真的装得下实测直链", DIRECT.length <= schemaLen, true);
// ensure-schema 只在「列已存在但更窄」时才会 MODIFY —— 这个分支不能只靠 columnExists
check(
  "ensure-schema 里同时有 ADD 与 WIDEN 两条 SQL（存量库是 VARCHAR(64)）",
  /SCHEDULE_VIDEOREF_SQL/.test(ensureSchema) &&
    /SCHEDULE_VIDEOREF_WIDEN_SQL/.test(ensureSchema) &&
    /columnLength\(\s*"Schedule"\s*,\s*"videoRef"\s*\)/.test(ensureSchema),
  true,
);

console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
