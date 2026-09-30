-- 门店放课节奏提醒（StudioWatch）
--
-- 为什么不复用 Reminder：Reminder 的外键和唯一键都挂在某一节 Schedule 上，
-- 而用户想蹲的是**还没放出来的**下周的课 —— 那时候没有 scheduleId 可挂。
-- 粒度应该是门店：「这家店每周三中午放课」。
--
-- ⚠ 这条提醒只有手机日历在真正工作（每周重复事件、不消耗订阅额度）。
--   服务端存一行只为「显示已设 / 能取消」—— 微信订阅消息是一次性的，
--   一周一次的推送第二周就会静默失效，那种"偶尔能收到"比收不到更糟。
--
-- 本文件必须与 src/lib/ensure-schema.js 的 STUDIO_WATCH_SQL 保持一致。

CREATE TABLE IF NOT EXISTS `StudioWatch` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NOT NULL,
  `studioId` INT NOT NULL,
  `weekday` INT NOT NULL,
  `hhmm` VARCHAR(5) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `StudioWatch_userId_studioId_key` (`userId`, `studioId`),
  INDEX `StudioWatch_userId_idx` (`userId`),
  CONSTRAINT `StudioWatch_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `StudioWatch_studioId_fkey`
    FOREIGN KEY (`studioId`) REFERENCES `Studio`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
