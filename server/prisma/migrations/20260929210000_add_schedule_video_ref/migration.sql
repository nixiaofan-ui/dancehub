-- 课程预告视频的「取址」：形如 `fityun|11058641|34103272`，非空即代表有预告视频。
-- 存「去哪儿取」而不是视频地址：菲体云给的是腾讯云点播签名链接，签名 1 小时过期。
ALTER TABLE `Schedule` ADD COLUMN `videoRef` VARCHAR(64) NULL;
