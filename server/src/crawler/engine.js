/**
 * 抓取引擎
 * - http 模式：直接调用 iWOD SaaS 的公开课表 API（无需登录），签名算法已逆向复现。
 * - fityun 模式：直接调用菲体云（fityun.cn）的公开课表 API，以请求头 orgid/branchid 定位机构与门店。
 * - oneMillion / avex 模式：解析日韩舞室官网 SSR 页面里内嵌的 JSON。
 * - justjerk 模式：JustJerk（首尔）官网只有「课表图片」，走「下载图片 → macOS Vision OCR
 *   → 栅格还原」的管线（见 tools/justjerk_ocr.py），本文件只负责取图与调用。
 * - automator 模式：通过 miniprogram-automator 启动微信开发者工具，
 *   打开目标小程序 → 跳转课表页 → 按配置的 CSS 选择器抽取课程卡片数据。
 * - mock 模式：返回演示数据（结构与真实卡片一致），便于无开发者工具环境联调。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 课名清洗（两个平台共用）：
 * 课程名首尾的「.」是舞室自己排版时留下的装饰符（如 ".SWAG"、"编舞."），直接展示会显得脏。
 * 只动首尾，**不改内部空格与标点** —— iWOD 的长课名里有刻意的双空格（"KIDS DANCE & PLAY  2-4 years old"），
 * 顺手压缩会大面积改动课名。
 * 注意：入库幂等键含 courseName，改动本函数后必须同步 UPDATE 库里已有行
 * （见 scripts/stat_dotnames.mjs），否则下一次抓取会插出重复课。
 */
function cleanCourseName(raw) {
  return String(raw ?? "")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");
}

/* ───────────────────────── iWOD HTTP 抓取 ───────────────────────── */

/** 签名时排除的字段（与小程序端 app-service.js 逻辑一致） */
const IWOD_SIGN_EXCLUDE = new Set(["pfx", "partner_key", "sign", "key"]);

/**
 * iWOD api_signature 签名（逆向自小程序 app-service.js，已用抓包样本 8/8 验证）：
 * 参数去空值并排除保留字 → 按 key 字典序排序 → "k=v&k=v" 拼接 →
 * 尾接 "&key={appId}" → MD5 → 大写。
 */
function iwodSignature(params, appId) {
  const qs = Object.keys(params)
    .filter((k) => !IWOD_SIGN_EXCLUDE.has(k) && String(params[k]) !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHash("md5")
    .update(`${qs}&key=${appId}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

/**
 * HTTP 抓取（iWOD SaaS 约课系统）
 * - 课表接口免登录（access_token=undefined 即可），仅返回公开课程数据
 * - isAllBoxClasses=1 时返回该品牌全部门店课表，按 boxName 区分门店
 * @param {object} config 抓取配置（含 config.http）
 * @param {Date} date 要抓取的日期（UTC 午夜）
 * @returns {Promise<Array>} 原始条目（含 _studioName 分店名）
 */
async function crawlWithHttp(config, date) {
  const { baseUrl = "https://api2.iwod.cn", appId, boxId } = config.http;
  if (!appId || !boxId) throw new Error("http 模式缺少 appId 或 boxId 配置");

  // 单店配置（allBoxes:false）时，以 config.studio.name 作为门店权威名称：
  // 同一品牌的多家分店若只返回「人广校区」这类裸店名，学员在列表里无法分辨，
  // 因此批量接入时用 generate_auto_configs.py 生成「品牌·店名（区）」的完整名。
  const singleStore = config.http.allBoxes === false;
  const fallbackName = singleStore ? config.studio?.name || "" : "";

  const dateStr = date.toISOString().slice(0, 10);
  const params = {
    timezoneOffset: "-480",
    access_token: "undefined",
    user_id: "undefined",
    box_id: String(boxId),
    language: "zh_CN",
    api_version: "3",
    appId,
    date: dateStr,
    timeRange: "[0,1,2,3,4]",
    // 连锁品牌置 1 可一次带出全部门店；单店配置置 0 避免重复请求
    isAllBoxClasses: singleStore ? "0" : "1",
    category: "0",
  };
  params.api_signature = iwodSignature(params, appId);

  const url = `${baseUrl}/class?${new URLSearchParams(params).toString()}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15",
      Referer: `https://servicewechat.com/${appId}/42/page-frame.html`,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`iWOD 接口 HTTP ${resp.status}`);

  const body = await resp.json();
  const inner = body?.data;
  if (!inner || inner.code !== 0) {
    throw new Error(`iWOD 接口返回异常: code=${inner?.code} ${inner?.errMsg || ""}`);
  }
  const timetable = inner?.data?.timetable || [];

  // 映射为通用卡片结构；_studioName 供 importer 按门店分别入库
  return timetable
    .filter((c) => c && c.name)
    .map((c) => ({
      courseName: cleanCourseName(c.name),
      coach: (c.coach || "").trim(),
      time: c.time || "",
      capacity: c.remain || (c.max_count != null ? String(c.max_count) : ""),
      status: c.newStatus || c.status || "",
      // 课程封面图（iWOD 独有；CDN 有防盗链，小程序 image 天然带 Referer 可直连）
      picUrl: c.pic || "",
      _studioName: fallbackName || (c.boxName || "").trim(),
      // 教室名（iWOD classroomName，如「大教室」），透传进 remark 供详情页展示
      _roomName: String(c.classroomName || c.classroom_name || "").trim(),
    }));
}

/* ───────────────────────── 菲体云 HTTP 抓取 ───────────────────────── */

/**
 * 菲体云（fityun.cn，深圳）SaaS 约课系统 —— 与 iWOD 并列的第二套平台。
 *
 * 逆向要点（2026-09-21 由 Phoenix 小程序抓包获得）：
 * - 机构与门店分别由 **HTTP 请求头** 标识，均免登录：
 *     orgid:    <机构ID>   例 11054206（Phoenix 火凤凰）
 *     branchid: <门店ID>   例 1560；**不传则返回主店**，故多门店必须逐店请求
 * - 课表接口 GET /tuancourse/dailyschedules?date=YYYY-MM-DD
 *     → info[].projectname 课名 / teachername 教练
 *       start_hour "15:00" + end_hour "16:00"（已格式化，无需解析时间戳）
 *       left 剩余名额 / maxstudent 容量 / roomname 教室
 * - 门店清单 GET /org/orglist → info.org_info[].{id:门店ID, branch_name, address, lng_lat, telphone}
 *
 * @param {object} config 抓取配置（含 config.fityun）
 * @param {Date} date 要抓取的日期（UTC 午夜）
 * @returns {Promise<Array>} 原始条目（含 _studioName 分店名）
 */
async function crawlWithFityun(config, date) {
  const {
    baseUrl = "https://xiaochengxu-edu-api-hz.fityun.cn",
    orgId,
    branches,
  } = config.fityun || {};
  if (!orgId) throw new Error("fityun 模式缺少 orgId 配置");

  const dateStr = date.toISOString().slice(0, 10);
  // 未配置分店时抓主店（不带 branchid）
  const targets =
    Array.isArray(branches) && branches.length
      ? branches
      : [{ id: "", name: config.studio?.name || "" }];

  const out = [];
  for (const br of targets) {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      orgid: String(orgId),
    };
    if (br.id) headers.branchid = String(br.id);

    const url =
      `${baseUrl}/tuancourse/dailyschedules` +
      `?date=${dateStr}&is_appoint=0&tagname=&teacherid=-1&classroomid=-1`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`菲体云接口 HTTP ${resp.status}`);

    const body = await resp.json();
    if (body?.status !== 0) {
      throw new Error(`菲体云接口返回异常: status=${body?.status} ${body?.info || ""}`);
    }

    for (const c of body.info || []) {
      const courseName = cleanCourseName(c.projectname);
      if (!courseName) continue;
      const time = c.start_hour && c.end_hour ? `${c.start_hour}-${c.end_hour}` : "";
      // "剩余/容量" 形式，mapper.parseCapacity 会取容量分母
      const capacity =
        c.maxstudent != null ? `${c.left != null ? c.left : ""}/${c.maxstudent}` : "";
      out.push({
        courseName,
        coach: String(c.teachername || "").trim(),
        time,
        capacity,
        status: Number(c.left) === 0 ? "已满" : "可预约",
        _studioName: (br.name || config.studio?.name || "").trim(),
        // 菲体云课表带 roomname（教室名），透传进 remark 供详情页展示
        _roomName: String(c.roomname || c.room_name || "").trim(),
      });
    }
  }
  return out;
}

/* ───────────────────────── 1MILLION 官网抓取 ───────────────────────── */

/**
 * 1MILLION Dance Studio（韩国首尔）官网课表抓取。
 *
 * 技术路线：
 * - 1MILLION 官网 /schedule/week 是 Next.js SSR，HTML 中直接嵌入 RSC payload JSON。
 * - payload 格式：escaped JSON，关键字段 `{\\\"booking_status\\\":...}`，
 *   schedule 子对象含 startAt/endAt（UTC ISO8601）、teacher[].name、
 *   schedule_type.name（舞种）、capacity_book、branch_place.name。
 * - 一次抓取覆盖全品牌 + 未来 30 天，无需逐店逐天请求。
 *
 * @param {object} config 抓取配置（含 config.oneMillion）
 * @param {Date} date 基准日期（用于计算 30 天范围，实际解析页面全量）
 * @returns {Promise<Array>} 原始条目
 */
async function crawlWithOneMillion(config, _date) {
  const { baseUrl = "https://www.1milliondance.com" } = config.oneMillion || {};

  const url = `${baseUrl}/schedule/week`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`1MILLION 接口 HTTP ${resp.status}`);

  const html = await resp.text();
  // 提取所有 ScheduleData 对象（escaped JSON）
  const marker = '{\\"booking_status\\"';
  const list = [];
  let i = html.indexOf(marker);
  while (i !== -1) {
    let depth = 0, j = i;
    for (; j < html.length; j++) {
      if (html[j] === '\\') { j++; continue; }
      // 跳过转义引号后面的字符
      if (html[j] === '"') {
        j++;
        continue;
      }
      if (html[j] === '{') depth++;
      else if (html[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const raw = html.slice(i, j + 1).replace(/\\"/g, '"');
    try {
      const obj = JSON.parse(raw);
      if (obj?.schedule?.startAt) list.push(obj);
    } catch {
      // 跳过解析失败项
    }
    i = html.indexOf(marker, j + 1);
  }

  const studioName = config.studio?.name || "1MILLION";
  return list
    .filter((o) => o.schedule?.startAt)
    .map((o) => {
      const s = o.schedule;
      const startAt = new Date(s.startAt);
      const endAt = new Date(s.endAt);
      const timeStr =
        `${String(startAt.getHours()).padStart(2,"0")}:${String(startAt.getMinutes()).padStart(2,"0")}` +
        `-` +
        `${String(endAt.getHours()).padStart(2,"0")}:${String(endAt.getMinutes()).padStart(2,"0")}`;
      return {
        courseName: cleanCourseName(s.schedule_type?.name || ""),
        coach: s.teacher?.[0]?.name || "",
        time: timeStr,
        capacity: `${s.capacity_book || ""}`,
        status: o.booking_status || "",
        _studioName: studioName,
        _roomName: s.branch_place?.name || "",
        _scheduleDate: startAt.toISOString().slice(0, 10),
        _photoUrl: s.teacher?.[0]?.teacher_meta?.img_face_url || "",
      };
    });
}

/* ───────────────────────── avex MAJOR 抓取 ───────────────────────── */

/**
 * MAJOR Dance Studio（东京原宿/目黑 + 大阪心斋桥/梅田）avex 预约平台抓取。
 *
 * 技术路线：
 * - 平台：`https://apfec.avex.jp/front/trialsearch/?STORE_CODE=<code>&RANGE_DATE_SEARCH=14`
 * - SSR 页面内嵌 JS 变量，key 为 `"list_schedule_student"`，对应课程数组。
 * - 字段：CLASS_NAME（课名）、ARTISTNAME/SUBSTITUTE_ARTISTNAME（教练）、
 *         HOLD_SCHEDULE（「2026/09/22(火) 17:00～18:20」）、CAPACITY、IS_SOLD_OUT、
 *         PHOTO_L_PATH（照片路径）、GENRE_COURSE_NAME（舞种）、LOCATION_NAME（门店名）。
 * - STORE_CODE 维度键：EAST=1100030712，WEST=9999990009。
 *
 * @param {object} config 抓取配置（含 config.avex）
 * @param {Date} date 基准日期
 * @returns {Promise<Array>} 原始条目
 */
async function crawlWithAvex(config, _date) {
  const { storeCode, baseUrl = "https://apfec.avex.jp" } = config.avex || {};
  if (!storeCode) throw new Error("avex 模式缺少 storeCode 配置");

  const url = `${baseUrl}/front/trialsearch/?STORE_CODE=${storeCode}&RANGE_DATE_SEARCH=14`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) throw new Error(`avex 接口 HTTP ${resp.status}`);

  const html = await resp.text();
  const idx = html.indexOf('"list_schedule_student"');
  if (idx === -1) throw new Error("avex 页面未找到 list_schedule_student 字段");

  let start = html.lastIndexOf("=", idx);
  let b = html.indexOf("{", start);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let j = b; j < html.length; j++) {
    const c = html[j];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = j + 1; break; }
    }
  }
  if (end === -1) throw new Error("avex JSON 解析失败：未找到闭合括号");

  const raw = html.slice(b, end);
  let jobj;
  try {
    jobj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`avex JSON 解析失败: ${e.message}`);
  }

  const list = jobj.list_schedule_student || [];
  const studioLabel = config.studio?.name || "MAJOR";

  return list
    .filter((c) => c.CLASS_NAME)
    .map((c) => {
      // HOLD_SCHEDULE 格式："2026/09/22(火) 17:00～18:20"
      const match = c.HOLD_SCHEDULE?.match(/(\d{4}\/\d{2}\/\d{2}).*(\d{2}:\d{2}).*(\d{2}:\d{2})/);
      const timeStr = match ? `${match[2]}-${match[3]}` : "";
      const isSoldOut = c.IS_SOLD_OUT === "1";
      const photoPath = c.PHOTO_L_PATH || "";
      const photoUrl = photoPath
        ? `https://apfec.avex.jp/assets/img/artist/${photoPath}`
        : "";
      return {
        courseName: cleanCourseName(c.CLASS_NAME),
        coach: c.ARTISTNAME || c.SUBSTITUTE_ARTISTNAME || "",
        time: timeStr,
        capacity: String(c.CAPACITY || ""),
        status: isSoldOut ? "SOLD_OUT" : "AVAILABLE",
        _studioName: studioLabel,
        _roomName: c.LOCATION_NAME || "",
        _scheduleDate: match ? match[1].replace(/\//g, "-") : "",
        _photoUrl: photoUrl,
      };
    });
}

/* ───────────────────────── JustJerk（首尔）抓取 ───────────────────────── */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const JUSTJERK_OCR_SCRIPT = path.resolve(__dirname, "tools/justjerk_ocr.py");
const JUSTJERK_CACHE_DIR = path.resolve(__dirname, "../../.cache/justjerk");
const LEVEL_TO_DIFFICULTY = { 1: "BEGINNER", 2: "BEGINNER", 3: "INTERMEDIATE", 4: "ADVANCED", 5: "ADVANCED" };

/**
 * 从 Imweb 课表页里挑出「本月课表」图片。
 *
 * Imweb 的图片控件形如：
 *   <div class="_img_box" data-src="https://cdn.imweb.me/upload/<site>/<hash>.png">
 *     <img src="https://cdn.imweb.me/thumbnail/20260902/<hash>.png" />
 * 其中 src 是缩略图（路径里带上传日期），data-src 才是原图 —— OCR 用原图准确率明显更高。
 * 同一页面还有站点模板图（日期是很久以前），所以取「上传日期最新的一张」最稳。
 *
 * @param {string} html 课表页 HTML
 * @returns {{url: string, thumb: string, date: string}|null}
 */
export function pickScheduleImage(html) {
  const re = /<img[^>]*\ssrc="(https:\/\/cdn\.imweb\.me\/thumbnail\/(\d{8})\/[^"]+)"[^>]*>/g;
  let best = null;
  for (const m of html.matchAll(re)) {
    const [, thumb, date] = m;
    if (best && date <= best.date) continue;
    // data-src 挂在同一个 _img_box 上，位于该 <img> 之前
    const before = html.slice(Math.max(0, m.index - 800), m.index);
    const ds = before.match(/data-src="(https:\/\/cdn\.imweb\.me\/upload\/[^"]+)"/);
    best = { thumb, date, original: ds ? ds[1] : null };
  }
  if (!best) return null;
  return { url: best.original || best.thumb, thumb: best.thumb, date: best.date };
}

/** 下载课表图片到本地缓存（同一天只下一次） */
async function downloadImage(url, filePath) {
  const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`下载课表图片失败 HTTP ${resp.status}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(await resp.arrayBuffer()));
  return filePath;
}

/** 调 tools/justjerk_ocr.py（macOS Vision OCR），返回解析后的 JSON */
function runJustjerkOcr(python, imagePath, branchKey, weekdays = null) {
  return new Promise((resolve, reject) => {
    const args = [
      JUSTJERK_OCR_SCRIPT,
      imagePath,
      "--branch", branchKey,
      "--today", new Date().toISOString().slice(0, 10),
    ];
    if (weekdays) args.push("--weekdays", String(weekdays));

    const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`无法启动 ${python}：${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`课表 OCR 失败（退出码 ${code}）：${err.trim().slice(-300)}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`课表 OCR 输出不是合法 JSON：${e.message}`));
      }
    });
  });
}

/** OCR 结果 → 抓取引擎统一的原始条目结构 */
function justjerkEntriesToRaw(parsed, studioLabel, branchLabel) {
  return (parsed.entries || []).map((e) => {
    const coaches = e.coaches || [];
    const levels = coaches.map((c) => c.level).filter((v) => v != null);
    const level = levels.length ? Math.min(...levels) : null; // 一格两位老师时取较易的等级
    return {
      courseName: cleanCourseName(e.courseName || "OPEN CLASS"),
      coach: coaches.map((c) => c.name).join(" / "),
      time: `${e.startTime}-${e.endTime}`,
      capacity: "",
      status: "",
      _studioName: studioLabel,
      _roomName: branchLabel || parsed.branch,
      _scheduleDate: e.date,
      _difficulty: level ? LEVEL_TO_DIFFICULTY[level] : null,
      _remark: levels.length
        ? `等级：${coaches.map((c) => `${c.name} LV${c.level ?? "-"}`).join(" / ")}`
        : null,
    };
  });
}

/**
 * JustJerk（저스트절크，首尔 Hapjeong / Ewha 两校区）课表抓取。
 *
 * 技术路线：官网是 Imweb 建站，SCHEDULE 页**只有一张课表图片**，页面文案明确写着
 * 「상세한 공지 및 스케쥴 확인은 아래 인스타그램에서 가능합니다」（详细课表请看 Instagram），
 * 而 Instagram 官方 API 拿不到他人账号内容。所以走：
 *   取页面 → 找当月课表图 → 下载 → macOS Vision OCR → 栅格还原成结构化条目。
 *
 * ⚠ 依赖：本机需为 macOS + 已装 pyobjc-framework-Vision（见 tools/justjerk_ocr.py 头部说明）。
 *   容器化部署时此模式不可用，需改用预解析结果或人工录入。
 *
 * @param {object} config 抓取配置（含 config.justjerk.branches）
 * @param {Date} _date 基准日期（实际以 python 侧 --today 为准）
 * @returns {Promise<Array>} 原始条目
 */
async function crawlWithJustjerk(config, _date) {
  const cfg = config.justjerk || {};
  const branches = cfg.branches || [];
  if (!branches.length) throw new Error("justjerk 模式缺少 branches 配置");

  const python = cfg.python || process.env.JUSTJERK_PYTHON || "python3";
  const rows = [];

  for (const br of branches) {
    if (!br.url) throw new Error(`JustJerk 分支 ${br.key} 缺少 url`);
    const resp = await fetch(br.url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`JustJerk ${br.key} 课表页 HTTP ${resp.status}`);

    const img = pickScheduleImage(await resp.text());
    if (!img) throw new Error(`JustJerk ${br.key} 课表页未找到课表图片`);

    const ext = path.extname(new URL(img.url).pathname) || ".png";
    const imgPath = path.join(JUSTJERK_CACHE_DIR, `${br.key}-${img.date}${ext}`);
    if (!fs.existsSync(imgPath)) await downloadImage(img.url, imgPath);

    const parsed = await runJustjerkOcr(python, imgPath, br.key, br.weekdays);
    const studioLabel = br.studioName || config.studio?.name || "JustJerk";
    rows.push(...justjerkEntriesToRaw(parsed, studioLabel, br.label));
  }

  return rows;
}

/** 演示数据：对齐 MAX POWER 课程卡片（课程名/时间/教练/状态/容量） */
function mockRaw() {
  return [
    {
      courseName: "JAZZ FUNK 初级",
      coach: "Vivi",
      time: "19:30-20:30",
      capacity: "8/20",
      status: "预约中",
    },
    {
      courseName: "HIPHOP 中级",
      coach: "Kai",
      time: "20:40-21:40",
      capacity: "已满",
      status: "约满",
    },
    {
      courseName: "WAACKING 入门",
      coach: "Luna",
      time: "18:00-19:00",
      capacity: "3/20",
      status: "预约中",
    },
    {
      courseName: "LOCKING 高级",
      coach: "Jay",
      time: "18:00-19:00",
      capacity: "0/16",
      status: "已开场",
    },
  ];
}

/** 自动化抓取（需要本机微信开发者工具 + 目标小程序项目） */
async function crawlWithAutomator(config) {
  let automator;
  try {
    automator = await import("miniprogram-automator");
  } catch (e) {
    throw new Error(
      `未安装 miniprogram-automator，请先在 server/ 下执行 npm install。(${e.message})`,
    );
  }

  const { launch } = automator.default || automator;
  let miniProgram;
  try {
    miniProgram = await launch({
      cliPath: config.cliPath,
      projectPath: config.projectPath,
      port: config.automatorPort || 9420,
    });
  } catch (e) {
    throw new Error(
      `无法启动微信开发者工具，请确认已安装并开启「服务端口」。(${e.message})`,
    );
  }

  try {
    await miniProgram.reLaunch(`/${config.schedulePagePath}`);
    await sleep(config.pageLoadDelay || 800);

    const page = await miniProgram.currentPage();
    await page.waitFor(config.selectors.list, 10000);

    const cards = await page.$$(config.selectors.list);
    const raw = [];
    for (const card of cards) {
      const read = async (sel) => {
        if (!sel) return "";
        const node = await card.$(sel);
        if (!node) return "";
        return ((await node.text()) || "").trim();
      };
      raw.push({
        courseName: await read(config.selectors.courseName),
        coach: await read(config.selectors.coach),
        time: await read(config.selectors.time),
        capacity: await read(config.selectors.capacity),
        status: await read(config.selectors.status),
      });
    }
    return raw.filter((r) => r.courseName);
  } finally {
    await miniProgram.close().catch(() => {});
  }
}

/** 统一入口：返回原始条目数组 [{ courseName, coach, time, capacity, status }] */
export async function crawl(config, date = new Date()) {
  if (!config) throw new Error("缺少抓取配置");
  if (config.mode === "http") return crawlWithHttp(config, date);
  if (config.mode === "fityun") return crawlWithFityun(config, date);
  if (config.mode === "oneMillion") return crawlWithOneMillion(config, date);
  if (config.mode === "avex") return crawlWithAvex(config, date);
  if (config.mode === "justjerk") return crawlWithJustjerk(config, date);
  if (config.mode === "mock") return mockRaw();
  if (config.mode === "automator") return crawlWithAutomator(config);
  throw new Error(`未知抓取模式: ${config.mode}`);
}
