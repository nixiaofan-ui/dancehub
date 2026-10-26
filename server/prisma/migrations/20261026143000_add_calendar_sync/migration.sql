-- 手机日历订阅：网页端提醒的镜像数据 + 无鉴权拉取用的 token（日历 App 不会带请求头）
ALTER TABLE `User` ADD COLUMN `calToken` VARCHAR(64) NULL;
ALTER TABLE `User` ADD COLUMN `calReminders` JSON NULL;
CREATE UNIQUE INDEX `User_calToken_key` ON `User`(`calToken`);
