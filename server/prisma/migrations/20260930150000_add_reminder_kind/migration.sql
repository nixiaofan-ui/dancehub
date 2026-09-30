-- 约课提醒：同一节课允许同时存在「提醒我去抢」和「提醒我去上」两条提醒，
-- 所以唯一键从 (userId, scheduleId) 放宽到 (userId, scheduleId, kind)。
--
-- ⚠ 顺序不能反（必须与 src/lib/ensure-schema.js 一致）：
--   MySQL 的外键要有索引垫着，而 (userId, scheduleId) 这条唯一键正好被
--   Reminder 的 userId/scheduleId 外键用着 —— 先 DROP 会报
--   "Cannot drop index ... needed in a foreign key constraint"，被吞掉之后
--   旧约束仍在生效，同一节课的第二条提醒插不进去（线上表现为「设了提醒却
--   没反应」）。所以：加列 → 建新唯一索引 → 最后才删旧的。

ALTER TABLE `Reminder` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'CLASS';

ALTER TABLE `Reminder` ADD UNIQUE INDEX `Reminder_userId_scheduleId_kind_key` (`userId`, `scheduleId`, `kind`);

ALTER TABLE `Reminder` DROP INDEX `Reminder_userId_scheduleId_key`;
