-- 加宽 Schedule.videoRef：VARCHAR(64) → VARCHAR(512)
--
-- 起因：魔方约课的课程预告片是**公开且不过期**的 mp4 直链，可以直接落库
-- （与菲体云的「腾讯云点播签名链接 1 小时过期、只能存取址」相反）。
-- 但实测一条直链 75 字符：
--     https://media.yqdicloud.com/2026/10/07/<32位hash>.mp4
-- 比原来的 VARCHAR(64) 长 —— 严格模式下 INSERT 报 1406 Data too long，
-- 宽松模式下被静默截断成一个打不开的地址。所以必须加宽。
--
-- 512 是留余量（够 cdn 域名 + 两级日期路径 + 长文件名），不是算出来的边界值。
-- 纯加宽是 INPLACE 操作，不会锁表也不会丢数据。
--
-- ⚠ 本文件必须与 src/lib/ensure-schema.js 的 VIDEO_REF_LEN 保持一致。
--   云容器的启动命令是 `node src/index.js`，真正让存量库变宽的是
--   那里的 SCHEDULE_VIDEOREF_WIDEN_SQL（本文件只在有人跑 migrate 时生效）。

ALTER TABLE `Schedule`
  MODIFY COLUMN `videoRef` VARCHAR(512) NULL;
