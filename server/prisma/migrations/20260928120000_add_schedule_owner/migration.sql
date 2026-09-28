-- 用户手录的课标记归属：null = 抓取来的公共课（所有人可见），有值 = 仅本人可见
ALTER TABLE `Schedule`
  ADD COLUMN `ownerId` INT NULL,
  ADD INDEX `Schedule_ownerId_idx` (`ownerId`);

ALTER TABLE `Schedule`
  ADD CONSTRAINT `Schedule_ownerId_fkey`
    FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
