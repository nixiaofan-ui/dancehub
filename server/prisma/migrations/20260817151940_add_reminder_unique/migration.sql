-- AlterTable
ALTER TABLE `Reminder` ADD UNIQUE INDEX `Reminder_userId_scheduleId_key`(`userId`, `scheduleId`);
