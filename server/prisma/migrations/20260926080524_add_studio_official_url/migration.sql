-- AlterTable
-- 海外场馆（首尔等）没有微信小程序，「去预约」改为 web-view 打开官网。
-- 国内场馆留空，仍走 bookingMiniAppId 的 navigateToMiniProgram。
ALTER TABLE `Studio` ADD COLUMN `officialUrl` VARCHAR(191) NULL;
