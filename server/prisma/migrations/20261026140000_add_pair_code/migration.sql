-- 网页版登录配对码：小程序生成 6 位码 → 网页输入 → 两端同一个账号。
-- 云容器启动命令是 `node src/index.js`，不会跑 migrate deploy ——
-- 同一批 DDL 必须同步写进 src/lib/ensure-schema.js（PAIR_CODE_SQL），否则线上永远缺表。
CREATE TABLE IF NOT EXISTS `PairCode` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(8) NOT NULL,
  `userId` INT NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `PairCode_code_key` (`code`),
  INDEX `PairCode_userId_idx` (`userId`),
  CONSTRAINT `PairCode_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
