-- 抓取对账三件套：把「上游已经删掉的门店」判出来（见 src/lib/reconcile-studios.js）。
-- 云容器的启动命令是 `node src/index.js`，不会跑 migrate deploy —— 同一批 DDL 必须
-- 同步写进 src/lib/ensure-schema.js，否则线上永远缺列。
ALTER TABLE `Studio` ADD COLUMN `lastSeenAt` DATETIME(3) NULL;
ALTER TABLE `Studio` ADD COLUMN `lastCrawlConfigId` VARCHAR(64) NULL;
ALTER TABLE `Studio` ADD COLUMN `missedRounds` INT NOT NULL DEFAULT 0;
