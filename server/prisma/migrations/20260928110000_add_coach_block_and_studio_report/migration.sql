-- 用户屏蔽的老师 + 缺失舞室提报
-- （本机用 `prisma db push` 落地；容器启动时会由 lib/ensure-schema.js 幂等补表，
--   所以这份文件主要用于留档，不要求线上执行 migrate deploy）

CREATE TABLE IF NOT EXISTS `CoachBlock` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NOT NULL,
  `coachName` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `CoachBlock_userId_coachName_key` (`userId`, `coachName`),
  KEY `CoachBlock_userId_idx` (`userId`),
  CONSTRAINT `CoachBlock_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `StudioReport` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NULL,
  `name` VARCHAR(191) NOT NULL,
  `city` VARCHAR(191) NULL,
  `contact` VARCHAR(191) NULL,
  `comment` LONGTEXT NULL,
  `status` ENUM('PENDING','DONE','REJECTED') NOT NULL DEFAULT 'PENDING',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `StudioReport_status_idx` (`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
