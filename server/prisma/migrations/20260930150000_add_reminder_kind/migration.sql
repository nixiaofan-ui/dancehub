-- 抢课闹钟：同一节课允许同时存在「提醒我去抢」和「提醒我去上」两条提醒，
-- 所以唯一键从 (userId, scheduleId) 放宽到 (userId, scheduleId, kind)。
ALTER TABLE `Reminder` DROP INDEX `Reminder_userId_scheduleId_key`;
ALTER TABLE `Reminder` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'CLASS';
ALTER TABLE `Reminder` ADD UNIQUE INDEX `Reminder_userId_scheduleId_kind_key` (`userId`, `scheduleId`, `kind`);
