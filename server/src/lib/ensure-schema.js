/**
 * 云端的表结构补齐。
 *
 * 为什么不用 prisma migrate deploy：
 * 容器启动命令是 `node src/index.js`，官方提供的启动钩子只在构建阶段跑，
 * 而运维同学手上不一定有数据库公网入口（我们本来就建议把公网关掉）。
 * 于是改成进程启动时自己补一次表 —— 幂等 DDL，跑一万次也只有第一次生效。
 *
 * 这套约定的代价：schema.prisma 仍然是唯一事实源，这里的 SQL 必须手动对齐，
 * 新增表/字段后如果忘了同步，线上会一直缺表。所以每个表都留了显眼的注释。
 */
import { prisma } from "./prisma.js";

/**
 * CoachBlock（用户屏蔽的老师）
 * 对应 schema.prisma 的 model CoachBlock
 */
const COACH_BLOCK_SQL = `
CREATE TABLE IF NOT EXISTS \`CoachBlock\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`userId\` INT NOT NULL,
  \`coachName\` VARCHAR(191) NOT NULL,
  \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE INDEX \`CoachBlock_userId_coachName_key\` (\`userId\`, \`coachName\`),
  INDEX \`CoachBlock_userId_idx\` (\`userId\`),
  CONSTRAINT \`CoachBlock_userId_fkey\`
    FOREIGN KEY (\`userId\`) REFERENCES \`User\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`;

/**
 * CoachFollow（用户标记「常看的老师」）
 * 对应 schema.prisma 的 model CoachFollow
 */
const COACH_FOLLOW_SQL = `
CREATE TABLE IF NOT EXISTS \`CoachFollow\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`userId\` INT NOT NULL,
  \`coachName\` VARCHAR(191) NOT NULL,
  \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE INDEX \`CoachFollow_userId_coachName_key\` (\`userId\`, \`coachName\`),
  INDEX \`CoachFollow_userId_idx\` (\`userId\`),
  CONSTRAINT \`CoachFollow_userId_fkey\`
    FOREIGN KEY (\`userId\`) REFERENCES \`User\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`;

/**
 * StudioReport（用户提报缺失的舞室）
 * 对应 schema.prisma 的 model StudioReport
 */
const STUDIO_REPORT_SQL = `
CREATE TABLE IF NOT EXISTS \`StudioReport\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`userId\` INT NULL,
  \`name\` VARCHAR(191) NOT NULL,
  \`city\` VARCHAR(191) NULL,
  \`contact\` VARCHAR(191) NULL,
  \`comment\` TEXT NULL,
  \`status\` ENUM('PENDING','DONE','REJECTED') NOT NULL DEFAULT 'PENDING',
  \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  INDEX \`StudioReport_status_idx\` (\`status\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`;

/**
 * Schedule.ownerId（用户手录的课标记归属）
 * 对应 schema.prisma 的 model Schedule 里的 ownerId / owner 关系。
 *
 * 加列用「查 information_schema 再 ALTER」而不是裸 ALTER：
 * MySQL 没有 ADD COLUMN IF NOT EXISTS，重复 ALTER 会抛 1060 把启动日志刷满。
 */
const SCHEDULE_OWNER_SQL = `
ALTER TABLE \`Schedule\`
  ADD COLUMN \`ownerId\` INT NULL,
  ADD INDEX \`Schedule_ownerId_idx\` (\`ownerId\`),
  ADD CONSTRAINT \`Schedule_ownerId_fkey\`
    FOREIGN KEY (\`ownerId\`) REFERENCES \`User\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE;
`;

/** 真实已约人数（舞室官方系统口径），区别于本小程序的 Booking 表计数 */
const SCHEDULE_BOOKEDNUM_SQL = `
ALTER TABLE \`Schedule\`
  ADD COLUMN \`bookedNum\` INT NULL;
`;

/**
 * 课程预告视频的「取址」或直链（非空即代表这节课有预告）。
 * 两形态并存，分派见 src/services/schedule-video.js：
 *   · `fityun|11058641|34103272` —— 菲体云，存「取址」不存 URL
 *     （腾讯云点播签名链接 1 小时过期，落库即死链）；
 *   · `https://media.yqdicloud.com/....mp4` —— 魔方约课，公开且不过期，直接存 URL。
 * ⚠ 长度按直链定：实测魔方约课一条 75 字符，VARCHAR(64) 装不下（MySQL 严格模式下
 *    报 1406 Data too long），所以列宽是 512。别改小。
 */
const VIDEO_REF_LEN = 512;

const SCHEDULE_VIDEOREF_SQL = `
ALTER TABLE \`Schedule\`
  ADD COLUMN \`videoRef\` VARCHAR(${VIDEO_REF_LEN}) NULL;
`;

/**
 * 存量库里 videoRef 已经建成了 VARCHAR(64)（20260929 那版），
 * ⚠️ 光靠上面的 ADD COLUMN 分支变不宽 —— `columnExists` 只判断「有没有」，
 *    列已经在了就直接跳过，新的宽度永远落不到线上，表现是魔方约课的视频
 *    在详情页整块不出现（写入时被截断/报错，库里是 NULL）。
 *    所以必须单独判一次宽度再 MODIFY。
 */
const SCHEDULE_VIDEOREF_WIDEN_SQL = `
ALTER TABLE \`Schedule\`
  MODIFY COLUMN \`videoRef\` VARCHAR(${VIDEO_REF_LEN}) NULL;
`;

/**
 * Studio.district（所在行政区，短名如「海淀」「余杭」）
 * 对应 schema.prisma 的 model Studio 里的 district。
 */
const STUDIO_DISTRICT_SQL = `
ALTER TABLE \`Studio\`
  ADD COLUMN \`district\` VARCHAR(32) NULL;
`;

/**
 * Studio.lat / Studio.lng（经纬度，GCJ-02，与微信/腾讯地图同一套坐标系）
 * 对应 schema.prisma 的 model Studio 里的 lat / lng。
 */
const STUDIO_LATLNG_SQL = `
ALTER TABLE \`Studio\`
  ADD COLUMN \`lat\` DOUBLE NULL,
  ADD COLUMN \`lng\` DOUBLE NULL;
`;

async function run(label, sql) {
  try {
    await prisma.$executeRawUnsafe(sql);
  } catch (err) {
    // 建表失败不该让整个服务起不来：缺表的功能会报错，其余功能照常可用
    console.error(`[dancehub] ensure-schema "${label}" 失败: ${err.message}`);
  }
}

async function columnExists(table, column) {
  const rows = await prisma
    .$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      table,
      column
    )
    .catch(() => [{ c: 1 }]);
  return Number(rows?.[0]?.c || 0) > 0;
}

/**
 * 列的当前字符长度上限（VARCHAR 用 CHARACTER_MAXIMUM_LENGTH）。
 * 查不到时返回 null —— 调用方据此跳过「加宽」，宁可不变也别乱 MODIFY。
 */
async function columnLength(table, column) {
  const rows = await prisma
    .$queryRawUnsafe(
      `SELECT CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      table,
      column,
    )
    .catch(() => []);
  const n = Number(rows?.[0]?.n);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function indexExists(table, index) {
  const rows = await prisma
    .$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      table,
      index,
    )
    .catch(() => [{ c: 1 }]);
  return Number(rows?.[0]?.c || 0) > 0;
}

/**
 * StudioWatch（门店放课节奏提醒）
 * 对应 schema.prisma 的 model StudioWatch
 *
 * 新表，存量库里没有 —— 用 CREATE TABLE IF NOT EXISTS，跑一万次也只有第一次生效。
 */
const STUDIO_WATCH_SQL = `
CREATE TABLE IF NOT EXISTS \`StudioWatch\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`userId\` INT NOT NULL,
  \`studioId\` INT NOT NULL,
  \`weekday\` INT NOT NULL,
  \`hhmm\` VARCHAR(5) NOT NULL,
  \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE INDEX \`StudioWatch_userId_studioId_key\` (\`userId\`, \`studioId\`),
  INDEX \`StudioWatch_userId_idx\` (\`userId\`),
  CONSTRAINT \`StudioWatch_userId_fkey\`
    FOREIGN KEY (\`userId\`) REFERENCES \`User\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT \`StudioWatch_studioId_fkey\`
    FOREIGN KEY (\`studioId\`) REFERENCES \`Studio\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`;

/** Reminder.kind（抢课闹钟与开课提醒共存的前提） */
const REMINDER_KIND_SQL = `
ALTER TABLE \`Reminder\` ADD COLUMN \`kind\` VARCHAR(191) NOT NULL DEFAULT 'CLASS';
`;

/**
 * ⚠️ 顺序不能反。
 * MySQL 的外键必须有索引垫着，而 (userId, scheduleId) 这条唯一键正好被
 * Reminder 的 userId/scheduleId 外键用着 —— 直接 DROP 会报
 * "Cannot drop index ... needed in a foreign key constraint"，被 run() 吞掉之后
 * 旧约束仍在生效，同一节课的第二条提醒（SNIPE）插不进去，线上表现为
 * 「设了抢课闹钟却没反应」，还极难定位。所以先加新index、再删旧的。
 */
const REMINDER_OLD_UNIQ = "Reminder_userId_scheduleId_key";
const REMINDER_NEW_UNIQ = "Reminder_userId_scheduleId_kind_key";
const REMINDER_NEW_UNIQ_SQL =
  "ALTER TABLE `Reminder` ADD UNIQUE INDEX `Reminder_userId_scheduleId_kind_key` (`userId`, `scheduleId`, `kind`)";

export async function ensureSchema() {
  await run("CoachBlock", COACH_BLOCK_SQL);
  await run("CoachFollow", COACH_FOLLOW_SQL);
  await run("StudioReport", STUDIO_REPORT_SQL);
  await run("StudioWatch", STUDIO_WATCH_SQL);
  // 存量库已经有 Schedule 表，只缺这一列
  if (!(await columnExists("Schedule", "ownerId"))) {
    await run("Schedule.ownerId", SCHEDULE_OWNER_SQL);
  }
  if (!(await columnExists("Schedule", "bookedNum"))) {
    await run("Schedule.bookedNum", SCHEDULE_BOOKEDNUM_SQL);
  }
  // videoRef 既要「没有就建」，也要「建窄了就加宽」——存量库是 VARCHAR(64)，
  // 装不下魔方约课的 mp4 直链（75 字符）。详见上面的 WIDEN 注释。
  if (!(await columnExists("Schedule", "videoRef"))) {
    await run("Schedule.videoRef", SCHEDULE_VIDEOREF_SQL);
  } else {
    const len = await columnLength("Schedule", "videoRef");
    if (len !== null && len < VIDEO_REF_LEN) {
      await run("Schedule.videoRef widen", SCHEDULE_VIDEOREF_WIDEN_SQL);
    }
  }
  if (!(await columnExists("Studio", "district"))) {
    await run("Studio.district", STUDIO_DISTRICT_SQL);
  }
  if (!(await columnExists("Studio", "lat"))) {
    await run("Studio.lat/lng", STUDIO_LATLNG_SQL);
  }
  // 老师搜索按名字匹配，存量库的 Coach 表没有这个索引
  if (!(await indexExists("Coach", "Coach_name_idx"))) {
    await run("Coach.name idx", "ALTER TABLE `Coach` ADD INDEX `Coach_name_idx` (`name`)");
  }
  // 抢课闹钟：同一节课允许同时挂「提醒抢」和「提醒上」两条
  if (!(await columnExists("Reminder", "kind"))) {
    await run("Reminder.kind", REMINDER_KIND_SQL);
  }
  if (!(await indexExists("Reminder", REMINDER_NEW_UNIQ))) {
    await run("Reminder new uniq", REMINDER_NEW_UNIQ_SQL);
  }
  if (await indexExists("Reminder", REMINDER_OLD_UNIQ)) {
    await run(
      "Reminder drop old uniq",
      `ALTER TABLE \`Reminder\` DROP INDEX \`${REMINDER_OLD_UNIQ}\``,
    );
  }
}
