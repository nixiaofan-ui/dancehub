/**
 * 测试专用 prisma 内存桩 —— 配合 prisma-stub-hooks.mjs 使用。
 *
 * hooks 把 server 里所有 `lib/prisma.js` 的导入重定向到本文件，
 * 这样 smoke 可以不连 MySQL 直接跑 importer / dedupe 的真实逻辑。
 * 只实现烟测用到的极小面：findMany / findFirst / update / create / deleteMany / $queryRaw。
 */

let seq = 1;
const db = {
  schedule: [],
  booking: [],
  reminder: [],
  studio: [],
  coach: [],
  city: [],
};

export function __reset() {
  seq = 1;
  for (const k of Object.keys(db)) db[k] = [];
}

const day = (v) => new Date(v).toISOString().slice(0, 10);

function matches(row, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    const got = row[k] ?? null;
    if (k === "scheduleDate") {
      if (day(got) !== day(v)) return false;
    } else if (v && typeof v === "object" && Array.isArray(v.in)) {
      if (!v.in.includes(got)) return false;
    } else if (Array.isArray(v)) {
      if (!v.includes(got)) return false;
    } else if (v !== undefined && got !== v) {
      return false;
    }
  }
  return true;
}

function model(name) {
  const rows = () => db[name];
  return {
    findMany: async ({ where } = {}) => rows().filter((r) => matches(r, where)),
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    create: async ({ data }) => {
      const row = { ...data, id: data.id ?? seq++ };
      rows().push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error(`[${name}] update: no row for ${JSON.stringify(where)}`);
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    deleteMany: async ({ where } = {}) => {
      const before = rows().length;
      for (let i = rows().length - 1; i >= 0; i--) {
        if (matches(rows()[i], where)) rows().splice(i, 1);
      }
      return { count: before - rows().length };
    },
  };
}

export const prisma = {
  schedule: model("schedule"),
  booking: model("booking"),
  reminder: model("reminder"),
  studio: model("studio"),
  coach: model("coach"),
  city: model("city"),
  $queryRaw: async () => [],
  $transaction: async (fns) => Promise.all(fns),
};
