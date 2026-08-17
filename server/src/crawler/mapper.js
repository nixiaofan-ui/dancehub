/**
 * 数据映射：原始卡片数据 → schedules 表字段
 * 原始字段：courseName / coach / time / capacity / status
 * 目标字段：courseName / difficulty / scheduleDate / startTime / endTime / capacity / remark / coachId
 */

const DIFFICULTY_RULES = [
  { keys: ["零基础", "入门", "初级", "基础"], difficulty: "BEGINNER" },
  { keys: ["中级"], difficulty: "INTERMEDIATE" },
  { keys: ["高级", "进阶"], difficulty: "ADVANCED" },
];

export function mapDifficulty(courseName = "") {
  for (const rule of DIFFICULTY_RULES) {
    if (rule.keys.some((k) => courseName.includes(k))) return rule.difficulty;
  }
  return "ALL_LEVELS";
}

/** 解析 "19:30-20:30" / "19:30~20:30" / "19:30 至 20:30" 等格式 */
export function parseTimeRange(text, format = "HH:mm-HH:mm") {
  if (!text) return { startTime: null, endTime: null };
  const parts = String(text).split(/-|~|至|—|–/);
  const toTime = (raw) => {
    if (!raw) return null;
    const m = String(raw).trim().match(/(\d{1,2})[:：点时](\d{2})?/);
    if (!m) return null;
    let h = Number(m[1]);
    let min = m[2] ? Number(m[2]) : 0;
    if (h === 24) {
      h = 23; // "24:00" 非法时间，收敛到 23:59
      min = 59;
    }
    if (min > 59) min = 59;
    return new Date(
      `1970-01-01T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`,
    );
  };
  return { startTime: toTime(parts[0]), endTime: toTime(parts[1]) };
}

/** 解析容量："8/20" → 20（取总量）；"16" → 16；"已满" → null */
export function parseCapacity(text) {
  if (!text) return null;
  const t = String(text).trim();
  const ratio = t.match(/(\d+)\s*\/\s*(\d+)/);
  if (ratio) return Number(ratio[2]);
  const plain = t.match(/^(\d+)$/);
  return plain ? Number(plain[1]) : null;
}

/** 原始条目 → schedule 写入字段 */
export function mapRawToSchedule(raw, { studioId, coachId, date }) {
  const time = parseTimeRange(raw.time);
  const status = (raw.status || "").trim();
  return {
    studioId,
    coachId: coachId ?? null,
    courseName: (raw.courseName || "").trim(),
    difficulty: mapDifficulty(raw.courseName),
    scheduleDate: date,
    startTime: time.startTime,
    endTime: time.endTime,
    capacity: parseCapacity(raw.capacity) ?? 30,
    bookingUrl: null,
    remark: status ? `抓取状态：${status}` : null,
  };
}
