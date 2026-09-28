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

export async function ensureSchema() {
  await run("CoachBlock", COACH_BLOCK_SQL);
  await run("CoachFollow", COACH_FOLLOW_SQL);
  await run("StudioReport", STUDIO_REPORT_SQL);
  // 存量库已经有 Schedule 表，只缺这一列
  if (!(await columnExists("Schedule", "ownerId"))) {
    await run("Schedule.ownerId", SCHEDULE_OWNER_SQL);
  }
}
