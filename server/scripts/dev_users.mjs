import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/**
 * 本机调试（服务端未配 appid/secret）产生的 dev 账号维护工具。
 *
 *   node scripts/dev_users.mjs                 # 列出所有 dev:xxx 账号
 *   node scripts/dev_users.mjs --delete dev:test-device-   # 按前缀删除
 *
 * 注意：必须用 /usr/local/bin/node 跑（托管 node 是 x64，Prisma 引擎是 darwin-arm64）。
 */
const p = new PrismaClient();

const flag = process.argv.indexOf("--delete");
const prefix = flag >= 0 ? process.argv[flag + 1] : null;

const users = await p.user.findMany({
  where: { openid: { startsWith: "dev:" } },
  select: {
    id: true,
    openid: true,
    nickname: true,
    createdAt: true,
    _count: { select: { follows: true, bookings: true } },
  },
  orderBy: { id: "asc" },
});

console.log(`dev 账号共 ${users.length} 个：`);
for (const u of users) {
  console.log(
    `  #${u.id}  ${u.openid}  关注${u._count.follows} 预约${u._count.bookings}  建于 ${String(u.createdAt).slice(0, 16)}`,
  );
}

if (prefix) {
  const targets = users.filter((u) => u.openid.startsWith(prefix));
  if (!targets.length) {
    console.log(`\n没有匹配前缀「${prefix}」的账号`);
  } else {
    const ids = targets.map((u) => u.id);
    // 先删引用方（follow / booking / reminder），再删 user，否则外键冲突
    const f = await p.follow.deleteMany({ where: { userId: { in: ids } } });
    const b = await p.booking.deleteMany({ where: { userId: { in: ids } } });
    const r = await p.reminder.deleteMany({ where: { userId: { in: ids } } });
    const u = await p.user.deleteMany({ where: { id: { in: ids } } });
    console.log(
      `\n已删除 ${u.count} 个账号（前缀 ${prefix}）：连带 ${f.count} 关注 / ${b.count} 预约 / ${r.count} 提醒`,
    );
  }
}

await p.$disconnect();
