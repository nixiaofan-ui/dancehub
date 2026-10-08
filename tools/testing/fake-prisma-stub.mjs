/**
 * 测试专用 prisma 内存桩 —— 配合 prisma-stub-hooks.mjs 使用。
 *
 * hooks 把 server 里所有 `lib/prisma.js` 的导入重定向到本文件，
 * 这样 smoke 可以不连 MySQL 直接跑 importer / dedupe 的真实逻辑。
 * 只实现烟测用到的极小面：findMany / findFirst / update / create / deleteMany / $queryRaw。
 *
 * ⚠ where 子句的支持范围直接决定「哪些代码路径测得动」。
 *   2026-10-08 补：原来只认标量 / 数组 / `{in:[]}`，而 pruneVanished 用的是
 *   `scheduleDate: { in: [Date, Date, ...] }` —— 旧版把 `{in:[...]}` 整个丢给
 *   `new Date()` 变成 Invalid Date、直接抛 RangeError。也就是说
 *   **pruneVanished 这条路径从来没有被任何烟测覆盖过**，而它正是当年
 *   积压 16827 条重复课的元凶。现在把 `in / gte / lte / none / not` 都补上。
 */

let seq = 1;
const db = {
  schedule: [],
  booking: [],
  reminder: [],
  studio: [],
  coach: [],
  city: [],
  follow: [],
};

export function __reset() {
  seq = 1;
  for (const k of Object.keys(db)) db[k] = [];
}

/** 日期字段一律按「天」比较（Prisma 的 DateTime 在库里也是这样被 where 掉的） */
const dayKey = (v) => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** 关系字段（bookings / reminders）在本桩里表现为「行上可能挂的数组」 */
function relationCount(row, field) {
  const v = row[field];
  return Array.isArray(v) ? v.length : 0;
}

function matchOperator(row, k, got, v) {
  // in
  if (v.in !== undefined) {
    const set = k === "scheduleDate" ? v.in.map(dayKey) : v.in;
    const g = k === "scheduleDate" ? dayKey(got) : got;
    if (!set.includes(g)) return false;
  }
  // not（标量或嵌套 in）
  if (v.not !== undefined) {
    const n = v.not;
    if (n && typeof n === "object" && Array.isArray(n.in)) {
      const set = k === "scheduleDate" ? n.in.map(dayKey) : n.in;
      const g = k === "scheduleDate" ? dayKey(got) : got;
      if (set.includes(g)) return false;
    } else if (n && typeof n === "object" && n.none !== undefined) {
      if (relationCount(row, k) > 0) return false;
    } else {
      const g = k === "scheduleDate" ? dayKey(got) : got;
      const cmp = k === "scheduleDate" ? dayKey(n) : n;
      if (g === cmp) return false;
    }
  }
  // 关系过滤：{ none: {} } = 「没有任何关联行」——对应 deleteMany 的
  // `bookings: { none: {} }`（有预约的课不许清）。桩里没有关系表，
  // 就按「行上没挂数组 = 没有关联」判定，语义与真实 Prisma 一致。
  if (v.none !== undefined) {
    if (relationCount(row, k) > 0) return false;
  }
  if (v.some !== undefined) {
    if (relationCount(row, k) === 0) return false;
  }
  // 范围
  if (v.gte !== undefined || v.lte !== undefined) {
    const g = k === "scheduleDate" ? dayKey(got) : got;
    if (v.gte !== undefined) {
      const lo = k === "scheduleDate" ? dayKey(v.gte) : v.gte;
      if (!(g >= lo)) return false;
    }
    if (v.lte !== undefined) {
      const hi = k === "scheduleDate" ? dayKey(v.lte) : v.lte;
      if (!(g <= hi)) return false;
    }
  }
  return true;
}

function matches(row, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    const got = row[k] ?? null;
    if (v === undefined) continue;
    if (v === null) {
      if (got !== null) return false;
      continue;
    }
    if (k === "scheduleDate") {
      if (dayKey(got) !== dayKey(v)) return false;
      continue;
    }
    if (Array.isArray(v)) {
      if (!v.includes(got)) return false;
      continue;
    }
    if (typeof v === "object") {
      if (!matchOperator(row, k, got, v)) return false;
      continue;
    }
    if (got !== v) return false;
  }
  return true;
}

function model(name) {
  const rows = () => db[name];
  return {
    findMany: async ({ where, select } = {}) => {
      const out = rows().filter((r) => matches(r, where));
      if (!select) return out;
      // select 只做字段裁剪：不裁剪会掩盖「读了不该读的字段」，但桩里保留
      // 完整对象会误导断言，所以按 select 挑字段（关联 select 原样带回）。
      return out.map((r) => {
        const picked = {};
        for (const key of Object.keys(select)) {
          if (select[key]) picked[key] = r[key];
        }
        return picked;
      });
    },
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    // createStudioOnce 的「并发建店」收尾要用 findUnique / delete；
    // 早先桩里没有这两个方法 → 那条去重路径只要被走到就 TypeError。
    findUnique: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    create: async ({ data }) => {
      const row = { ...data, id: data.id ?? seq++ };
      rows().push(row);
      return row;
    },
    delete: async ({ where } = {}) => {
      const i = rows().findIndex((r) => matches(r, where));
      if (i < 0) throw new Error(`[${name}] delete: no row for ${JSON.stringify(where)}`);
      return rows().splice(i, 1)[0];
    },
    update: async ({ where, data }) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error(`[${name}] update: no row for ${JSON.stringify(where)}`);
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    deleteMany: async ({ where } = {}) => {
      const before = rows().length;
      // 反向遍历，避免边删边改索引
      for (let i = rows().length - 1; i >= 0; i--) {
        if (matches(rows()[i], where)) rows().splice(i, 1);
      }
      return { count: before - rows().length };
    },
    count: async ({ where } = {}) => rows().filter((r) => matches(r, where)).length,
  };
}

export const prisma = {
  schedule: model("schedule"),
  booking: model("booking"),
  reminder: model("reminder"),
  studio: model("studio"),
  coach: model("coach"),
  city: model("city"),
  follow: model("follow"),
  $queryRaw: async () => [],
  $transaction: async (fns) => Promise.all(fns),
};
