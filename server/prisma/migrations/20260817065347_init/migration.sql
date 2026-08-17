-- CreateTable
CREATE TABLE `City` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `region` ENUM('CN', 'OVERSEAS') NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `City_region_name_key`(`region`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `User` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `openid` VARCHAR(191) NOT NULL,
    `nickname` VARCHAR(191) NULL,
    `avatarUrl` VARCHAR(191) NULL,
    `homeCityId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_openid_key`(`openid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Studio` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `cityId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `address` VARCHAR(191) NULL,
    `contact` VARCHAR(191) NULL,
    `logoUrl` VARCHAR(191) NULL,
    `platform` ENUM('WECHAT', 'NAVER', 'INSTAGRAM', 'OTHER') NOT NULL DEFAULT 'WECHAT',
    `status` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Studio_cityId_idx`(`cityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Coach` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `studioId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `avatarUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Coach_studioId_idx`(`studioId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Schedule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `studioId` INTEGER NOT NULL,
    `coachId` INTEGER NULL,
    `courseName` VARCHAR(191) NOT NULL,
    `difficulty` ENUM('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS') NOT NULL DEFAULT 'ALL_LEVELS',
    `scheduleDate` DATE NOT NULL,
    `startTime` TIME NOT NULL,
    `endTime` TIME NOT NULL,
    `bookingUrl` VARCHAR(191) NULL,
    `remark` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Schedule_studioId_scheduleDate_idx`(`studioId`, `scheduleDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Booking` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `scheduleId` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'CONFIRMED') NOT NULL DEFAULT 'PENDING',
    `method` ENUM('JUMP', 'MANUAL') NOT NULL DEFAULT 'JUMP',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Booking_userId_scheduleId_key`(`userId`, `scheduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Reminder` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `scheduleId` INTEGER NOT NULL,
    `type` ENUM('LOCAL') NOT NULL DEFAULT 'LOCAL',
    `remindAt` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Reminder_scheduleId_idx`(`scheduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Follow` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `studioId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Follow_studioId_idx`(`studioId`),
    UNIQUE INDEX `Follow_userId_studioId_key`(`userId`, `studioId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_homeCityId_fkey` FOREIGN KEY (`homeCityId`) REFERENCES `City`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Studio` ADD CONSTRAINT `Studio_cityId_fkey` FOREIGN KEY (`cityId`) REFERENCES `City`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Coach` ADD CONSTRAINT `Coach_studioId_fkey` FOREIGN KEY (`studioId`) REFERENCES `Studio`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Schedule` ADD CONSTRAINT `Schedule_studioId_fkey` FOREIGN KEY (`studioId`) REFERENCES `Studio`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Schedule` ADD CONSTRAINT `Schedule_coachId_fkey` FOREIGN KEY (`coachId`) REFERENCES `Coach`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `Schedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Reminder` ADD CONSTRAINT `Reminder_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Reminder` ADD CONSTRAINT `Reminder_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `Schedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Follow` ADD CONSTRAINT `Follow_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Follow` ADD CONSTRAINT `Follow_studioId_fkey` FOREIGN KEY (`studioId`) REFERENCES `Studio`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
