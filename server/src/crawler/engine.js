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
import { composeStudioName } from "./studio-name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 教练头像的取值：上游「没有头像」时不给空串，而是给一张**默认占位图**
 * （菲体云 default/customer/default.png、爱舞功 default_avatar 之类）。
 * 存进去的话每张卡都是同一张灰脸，比不显示更糟，所以这里统一当「没有」。
 */
export function pickImageUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s || !/^https?:\/\//i.test(s)) return null;
  if (/\/default[_\-/]|[_\-/]default\.(png|jpg|jpeg|webp)/i.test(s)) return null;
  // 上游给的 URL 偶尔带裸的非法字符（菲体云老师图路径里就有 `}`，
  // 形如 …/1621577440hx}5rio7.png），图片加载器会直接判为非法地址。
  // 只把这几个字符转成 %XX，其余原样保留（不整体 encodeURI，避免动到签名参数）。
  return s.replace(/[\s{}|\\^`"<>]/g, (ch) => encodeURIComponent(ch));
}

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

/**
 * 剥离开头的门店前缀： 《旗舰店》JAZZ基础 → JAZZ基础、安宁店Jazz → Jazz
 *
 * 菲体云里多校区的机构通常只有一个 orgId，校区名是硬塞进课名里的，
 * 直接展示的结果是列表里冒出一堆「前缀不同、内容相同」的课。
 *
 * 只在「开头」且「剥完还有内容」时才动手，避免把本身叫「午间基础班」的课洗坏；
 * 「海甸店」这种 2 字 + 店 的组合要覆盖，所以下限设 2。
 */
function stripBranchPrefix(name) {
  const raw = String(name || "");
  // 前缀必须**以「店/校区/分校」结尾**才剥，有没有《》()【】包着都认。
  // 「以店结尾」是判定的关键分寸：
  //   《旗舰店》JAZZ基础 → JAZZ基础      ✔ 门店前缀
  //   安宁店Jazz        → Jazz          ✔ 门店前缀
  //   【Zero】Jazz      → 不动           ✘ Zero 是课程代号，剥了会和普通 Jazz 撞车、
  //                                        幂等键错位后直接把课判重删掉
  // 前缀长度上限也别放宽到 6 以上，否则「午间基础班南关店」会被整条吃掉。
  const stripped = raw.replace(
    /^\s*[《【(（]?\s*[\u4e00-\u9fa5A-Za-z]{1,6}(店|校区|分校)\s*[》】)）]?\s*/,
    "",
  );
  // 剥完什么都不剩 = 误伤，保留原名（课丢了比名字难看严重得多）
  return stripped.trim() ? stripped : raw;
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
    .map((c) => {
      // ⚠ iWOD 的 remain 字段名是骗人的：它形如 "28/20"，用 status 交叉验证过
      // —— status=full（已满）的课分子总是大于分母（28/20、47/40、15/14），
      //    status=able 的课分子小于分母（0/50、2/20、10/45）。
      // 所以分子是「已预约人数」，分母才是总容量。当成「剩余名额」去减就整个反了。
      // 注意：其它平台（菲体云/共享中街等）我统一拼的是「剩余/总数」，
      // 两种格式分子语义相反，各自通过 _bookedNum 显式传递，不要让下游猜。
      const ratio = String(c.remain || "").match(/^(\d+)\s*\/\s*(\d+)$/);
      const bookedNum = ratio ? Number(ratio[1]) : null;
      return {
        courseName: cleanCourseName(c.name),
        coach: (c.coach || "").trim(),
        time: c.time || "",
        capacity: c.remain || (c.max_count != null ? String(c.max_count) : ""),
        status: c.newStatus || c.status || "",
        _bookedNum: bookedNum,
        // 课程封面图（iWOD 独有；CDN 有防盗链，小程序 image 天然带 Referer 可直连）
        picUrl: c.pic || "",
        _studioName: fallbackName || (c.boxName || "").trim(),
        // 教室名（iWOD classroomName，如「大教室」），透传进 remark 供详情页展示
        _roomName: String(c.classroomName || c.classroom_name || "").trim(),
      };
    });
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
/**
 * 菲体云的接口域名换过，而**旧域名不会报错，只是安静地返回空课表**：
 * 2026-09-29 晚发现所有生成配置里写死的 `xiaochengxu-edu-api-hz.fityun.cn`
 * 对 dailyschedules 稳定返回 `{status:0, info:{list:[]}}`，连测 4 次都是 0 节；
 * 同参数打 `xiaochengxu-v3-api.fityun.cn` 能拿到 10 节。更阴的是旧域名并没有死 ——
 * `/tuancourse/scheduleappointinfo`、`/project/getinfo` 都还正常，所以
 * 「接口通不通」这类健康检查发现不了它，只有比对课表内容才知道。
 *
 * ⚠ 两个域名的**响应形状还不一样**：旧域名 `info` 是数组，新域名 `info` 是
 * `{ iconType, list: [...], tagFilterList }`。只改 baseUrl 不改解析会直接崩在
 * `for...of`（对象不可迭代），所以统一走 pickFityunList()。
 *
 * 策略：优先用「本进程最近一次返回过非空课表的域名」；遇到空结果时换另一个域名
 * **复核一次**（只复核一次，避免每个真没排课的日子都多打一次请求）。上游再换
 * 域名时这里能自己切，不用我们盯着。
 */
const FITYUN_HOSTS = [
  "https://xiaochengxu-v3-api.fityun.cn",
  "https://xiaochengxu-edu-api-hz.fityun.cn",
];
let fityunHost = null; // 进程级记忆：上次成功返回非空课表的域名
let fityunEmptyChecked = false; // 是否已用另一个域名复核过空结果（只做一次）

/** info 既可能是数组（旧域名）也可能是 { list: [...] }（新域名） */
function pickFityunList(info) {
  if (Array.isArray(info)) return info;
  if (info && Array.isArray(info.list)) return info.list;
  return [];
}

/** 拉某机构某天课表，自动跨域名兜底；返回原始课程数组 */
async function fetchFityunDay({ baseUrl, orgId, branchId, dateStr }) {
  const custom = baseUrl && !FITYUN_HOSTS.includes(baseUrl) ? baseUrl : null;
  const ordered = [...new Set([fityunHost, custom, ...FITYUN_HOSTS].filter(Boolean))];

  for (let i = 0; i < ordered.length; i++) {
    const host = ordered[i];
    // 已有可信域名、且复核过一次空结果 → 不再为「那天真的没课」多打请求
    if (i > 0 && fityunEmptyChecked) break;
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      orgid: String(orgId),
    };
    if (branchId) headers.branchid = String(branchId);
    const url =
      `${host}/tuancourse/dailyschedules` +
      `?date=${dateStr}&is_appoint=0&tagname=&teacherid=-1&classroomid=-1`;
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!resp.ok) {
        console.warn(`[菲体云] ${host} HTTP ${resp.status}，换域名重试`);
        continue;
      }
      const body = await resp.json();
      if (body?.status !== 0) {
        console.warn(
          `[菲体云] ${host} status=${body?.status} ${body?.info || ""}，换域名重试`,
        );
        continue;
      }
      const list = pickFityunList(body.info);
      if (list.length) {
        if (fityunHost !== host) {
          console.log(
            `[菲体云] 课表域名切到 ${host}` +
              (fityunHost ? `（原 ${fityunHost} 返回空课表）` : ""),
          );
        }
        fityunHost = host;
        return list;
      }
      if (i > 0) fityunEmptyChecked = true;
    } catch (err) {
      console.warn(`[菲体云] ${host} 请求失败：${err.message}，换域名重试`);
    }
  }
  return [];
}

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
    const list = await fetchFityunDay({ baseUrl, orgId, branchId: br.id, dateStr });

    for (const c of list) {
      const courseName = cleanCourseName(stripBranchPrefix(c.projectname));
      if (!courseName) continue;
      const time = c.start_hour && c.end_hour ? `${c.start_hour}-${c.end_hour}` : "";
      // "剩余/容量" 形式，mapper.parseCapacity 会取容量分母
      const capacity =
        c.maxstudent != null ? `${c.left != null ? c.left : ""}/${c.maxstudent}` : "";
      // 真实已约 = 容量 - 剩余。注意 left 是**剩余**不是已约（和 iWOD 的 remain 相反）：
      // 实测 max=22/left=18 → 已约 4，且越近的课 left 越小、未开放预约的课 left=max。
      // 未开放（schedule_status 6 / -3）时 left 等于容量，算出来就是 0，也说得通。
      // 只认 0 <= left <= max 的区间，越界说明字段语义变了，宁可留 null。
      const max = Number(c.maxstudent);
      const left = Number(c.left);
      const bookedNum =
        Number.isFinite(max) && Number.isFinite(left) && left >= 0 && left <= max
          ? max - left
          : null;
      out.push({
        courseName,
        coach: String(c.teachername || "").trim(),
        time,
        capacity,
        status: Number(c.left) === 0 ? "已满" : "可预约",
        _bookedNum: bookedNum,
        // ⚠ `icon` 是**老师头像**（cloud/teacher/…、paid_org/employee/…），
        //   课程封面是另一个字段 `project_icon`。别拿错。
        //   缺头像时上游会给默认图 default/course/… 或空串，统一按没有处理。
        _coachAvatar: pickImageUrl(c.icon),
        _studioName: (br.name || config.studio?.name || "").trim(),
        // 菲体云课表带 roomname（教室名），透传进 remark 供详情页展示
        _roomName: String(c.roomname || c.room_name || "").trim(),
        // 「课程预告视频」的引用：菲体云的课表接口只在 `has_video=1` 时标记
        // 「这节课有预告视频」，视频地址要另打 /tuancourse/scheduleappointinfo。
        // 那个地址是**腾讯云点播的签名链接，签名 1 小时就过期**，所以这里只存
        // 「去哪儿取」（机构ID + 排课ID），绝不存 URL —— 存了半小时后就是死链。
        // 详情页打开时再按需回源（见 services/fityun-video.js）。
        _videoRef:
          Number(c.has_video) === 1 && c.scheduleid
            ? `fityun|${orgId}|${c.scheduleid}`
            : null,
      });
    }
  }
  return out;
}

/* ───────────────────────── styd.cn（第四套平台）抓取 ───────────────────────── */

/**
 * styd.cn（杭州/上海，API 域 stmember.styd.cn）—— 继 iWOD、菲体云、爱舞功之后的
 * **第四套**舞蹈/健身 SaaS。HERE&NOW 街舞、TI 舞蹈、SUPER 舞蹈室等在用。
 *
 * 逆向要点（2026-09-28 由 Mac 微信缓存的小程序包解密 + 接口探测获得）：
 * - 免登录课表接口 GET /v1/appointment/team_course_list
 *     查询参数 brand_id / shop_id / date=YYYY-MM-DD / course_type=team_course
 * - **请求头是钥匙**，缺一个就报错：
 *     app-id: mina        （固定值，只接受 mina / h5）
 *     brand-code: <品牌码> 12 位随机串，例 a2DGxRkY0ya；从小程序包里硬编码取得
 *     shop-id: <门店ID>   16 位雪花 ID
 * - 门店清单 GET /v1/shop/shop_by_city?brand_code=<品牌码>（免登录）
 *     → data.other_shop[] = [{ id, shop_name, province_name, city_name, district_name, address }]
 *     注意：/v2/platform/nearby_shop_list 按坐标只返回 3 家且**不含未开「附近展示」的门店**
 *     （HERE&NOW 就不在里面），所以必须用 shop_by_city 拿品牌自己的门店。
 * - 课程字段：course_name 课名 / coach_name 教练 / start_time "19:00" + end_time "20:00" /
 *     reserve_max 容量 / reserved_num 已约 / category_name 分类（多为难度/门槛说明）
 *
 * @param {object} config 抓取配置（含 config.styd）
 * @param {Date} date 要抓取的日期
 * @returns {Promise<Array>} 原始条目（含 _studioName 门店名）
 */
async function crawlWithStyd(config, date) {
  const {
    baseUrl = "https://stmember.styd.cn",
    brandCode,
    brandId,
    shops,
  } = config.styd || {};
  if (!brandCode) throw new Error("styd 模式缺少 brandCode 配置");
  if (!brandId) throw new Error("styd 模式缺少 brandId 配置");

  const dateStr = date.toISOString().slice(0, 10);
  const targets =
    Array.isArray(shops) && shops.length
      ? shops
      : [{ id: "", name: config.studio?.name || "" }];

  const out = [];
  // 门店档案：当天没课的分店也要留在库里（与嘉禾 / csdsp 同策略）
  out.ensureStudios = targets
    .filter((s) => s && s.id && s.name)
    .map((s) => ({
      name: String(s.name).trim(),
      city: s.city,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
    }));

  for (const shop of targets) {
    if (!shop.id) continue;
    const headers = {
      "app-id": "mina",
      "brand-code": String(brandCode),
      "shop-id": String(shop.id),
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    };
    const url =
      `${baseUrl}/v1/appointment/team_course_list` +
      `?brand_id=${encodeURIComponent(brandId)}` +
      `&shop_id=${encodeURIComponent(shop.id)}` +
      `&date=${dateStr}&course_type=team_course`;

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`styd 接口 HTTP ${resp.status}`);

    const body = await resp.json();
    // code 非 0 视为该店当天无课/未配置，不抛错（避免整条链断掉）
    if (body?.code !== 0) continue;

    for (const c of body?.data?.course_list || []) {
      const courseName = cleanCourseName(c.course_name);
      if (!courseName) continue;
      const time = c.start_time && c.end_hour ? `${c.start_time}-${c.end_hour}` : c.start_time && c.end_time ? `${c.start_time}-${c.end_time}` : "";
      const max = c.reserve_max != null ? Number(c.reserve_max) : null;
      const used = c.reserved_num != null ? Number(c.reserved_num) : null;
      const capacity = max ? `${used != null ? max - used : ""}/${max}` : "";
      out.push({
        courseName,
        coach: String(c.coach_name || "").trim(),
        time,
        capacity,
        status: max && used != null && used >= max ? "已满" : "可预约",
        _bookedNum: used,
        _studioName: (shop.name || config.studio?.name || "").trim(),
        // 门店级档案（配置里带）：地址/坐标/城市，供 importer 建档时写进去
        _address: shop.address,
        _city: shop.city,
        _lat: shop.lat,
        _lng: shop.lng,
        // category_name 多为「舞龄50节课起」这类门槛说明，透传进 remark
        _remark: String(c.category_name || "").trim(),
      });
    }
  }
  return out;
}

/* ─────────────── 咪哩约课（miliyoga.com）抓取 ─────────────── */

/** 咪哩约课的 apiKey，硬编码在学员端小程序包里（capture/mili_api.py 同款） */
const MILI_API_KEY = "Mp6AbNLllvJRp7tB";
const MILI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50";

/**
 * 咪哩约课签名：`md5(apiKey + "k1=v1&k2=v2" + apiKey)`，参数按 **key 升序**（key 统一转小写），
 * 空值参与且作为空串，不含 X-Mili-* 请求头。
 */
function miliSignature(params, apiKey) {
  const body = Object.keys(params)
    .map((k) => [String(k).toLowerCase(), params[k] == null ? "" : String(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return crypto.createHash("md5").update(`${apiKey}${body}${apiKey}`, "utf8").digest("hex");
}

/**
 * 咪哩约课（api-esa.miliyoga.com）—— 继 iWOD / 菲体云 / 爱舞功 / styd 之后的**第五套**舞蹈 SaaS。
 * 瑜伽馆/舞室通用（嘉兴小粒信息），学员端是**一套通用包**：租户标识 `pk`（形如 9iwjnvceyz，
 * 10 位小写字母数字）在进场 scene 里下发，不在包内 —— 所以每家店必须单独从抓包里取 pk。
 *
 * 逆向要点（2026-09-30 手机抓包 + 小程序包解密）：
 * - 免登录课表 GET `/fronts/<pk>/schedule/groups?ctype=1&sdate=YYYY-MM-DD&include=course,coach,users`
 * - **签名是钥匙**：X-Mili-Sign 缺了/算错一律 404 "Not find."（和 pk 失效长得一样，别误判）
 * - 门店清单 GET `/fronts/<pk>/brand?include=places` → data.places[] 是整个品牌的全部门店，
 *   一次就能拿到分店名 + 地址 + 省市，不用一家家找（返回值里也带各自的 hash_key = pk）
 * - 课程字段：course.course_name 课名 / coach.true_name 教练 / coach.avatar_url 头像 /
 *     sdate_start + sdate_end "18:40" / people_num 容量 / reserve_num 已约 / sur_num 剩余
 */
async function crawlWithMiliyoga(config, date) {
  const {
    baseUrl = "https://api-esa.miliyoga.com/fronts",
    apiKey = MILI_API_KEY,
    places,
  } = config.miliyoga || {};
  if (!Array.isArray(places) || !places.length) {
    throw new Error("miliyoga 模式缺少 places 配置");
  }

  const dateStr = date.toISOString().slice(0, 10);
  const brandName = (config.studio?.name || "").trim();
  const out = [];
  // 门店档案：当天没课的分店也要留在库里（与嘉禾 / csdsp 同策略）
  out.ensureStudios = places
    .filter((p) => p && p.pk && p.name)
    .map((p) => ({
      name: composeStudioName(brandName, p.name),
      city: p.city,
      address: p.address,
      lat: p.lat,
      lng: p.lng,
    }));

  for (const place of places) {
    const pk = String(place.pk || "").trim();
    if (!pk) continue;
    const params = { ctype: "1", sdate: dateStr, include: "course,coach,users" };
    const url = `${baseUrl}/${pk}/schedule/groups?${new URLSearchParams(params)}`;

    const resp = await fetch(url, {
      headers: {
        "X-Mili-Token": "",
        "X-Mili-Platform": "WX_XCX",
        "X-Mili-Appversion": "2.1.1",
        "X-Mili-Time": String(Math.floor(Date.now() / 1000)),
        "X-Mili-Preview": "",
        "X-Mili-Identity": "1",
        "X-Mili-Sign": miliSignature(params, apiKey),
        Accept: "application/vnd.api.v1+json",
        "Content-Type": "application/json",
        "User-Agent": MILI_UA,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`咪哩约课接口 HTTP ${resp.status}`);

    const json = await resp.json();
    // meta.code 非 200 视为该店当天无课（或 pk 失效），不抛错，避免整条链断掉
    if (json?.meta?.code !== 200) continue;

    for (const g of json.data || []) {
      const courseName = cleanCourseName(g.course?.course_name);
      if (!courseName) continue;
      const max = g.people_num != null ? Number(g.people_num) : null;
      const used = g.reserve_num != null ? Number(g.reserve_num) : null;
      out.push({
        courseName,
        coach: String(g.coach?.true_name || "").trim(),
        _coachAvatar: pickImageUrl(g.coach?.avatar_url),
        time: `${g.sdate_start || ""}-${g.sdate_end || ""}`,
        capacity: max ? `${used ?? ""}/${max}` : "",
        status: max && used != null && used >= max ? "已满" : "可预约",
        _bookedNum: used,
        _studioName: composeStudioName(brandName, place.name),
        _photoUrl: pickImageUrl(g.course?.bg_img_url),
        _city: place.city,
        _address: place.address,
      });
    }
  }
  return out;
}

/* ─────────────── 一只鸟 / 亦知鸟（yizhiniao.com）抓取 ─────────────── */

/**
 * 一只鸟（www.yizhiniao.com）—— 又一套场馆 SaaS（舞岚舞蹈实验室在用）。
 * 免登录，两个接口足够：
 * - 门店：GET `/api/user/website/getShopListByWxappid?wxappid=<appId>`（按小程序 appId 反查品牌全部门店）
 * - 课表：GET `/api/user/course/bookingArrangingCourseList3?beginTime=&endTime=&shopId=`
 *     ⚠ 参数是 `beginTime`/`endTime`（"YYYY-MM-DD HH:mm:ss"），**不是 date**
 * - 返回 `context[].arrangingStudentList[]`，每条的 course.courseName 是课名、
 *     shopTeacherList[0] 是教练、classInfo.classMax 是容量、arrangingCourses.bookingTotal 是已约
 */
async function crawlWithYizhiniao(config, date) {
  const { baseUrl = "https://www.yizhiniao.com", shops } = config.yizhiniao || {};
  if (!Array.isArray(shops) || !shops.length) {
    throw new Error("yizhiniao 模式缺少 shops 配置");
  }

  const dateStr = date.toISOString().slice(0, 10);
  const profiles = new Map(shops.map((s) => [String(s.name || "").trim(), s]));
  const out = [];
  // 门店档案：当天没课的分店也要留在库里（与嘉禾 / csdsp 同策略）
  out.ensureStudios = shops
    .filter((s) => s && s.name)
    .map((s) => ({
      name: String(s.name).trim(),
      city: s.city,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
    }));

  // ⚠ 这个接口**忽略 shopId**：传任何一家店的 id，返回的都是品牌**全部门店**，
  //    按 context[] 分组。所以只请求一次再按分组落库 —— 按 shopId 循环会得到
  //    3 倍重复数据（幂等 upsert 兜得住，但白写 3 遍，抓取耗时也翻三倍）。
  const qs = new URLSearchParams({
    beginTime: `${dateStr} 00:00:00`,
    endTime: `${dateStr} 23:59:59`,
    shopId: String(shops[0].id || ""),
  });
  const resp = await fetch(`${baseUrl}/api/user/course/bookingArrangingCourseList3?${qs}`, {
    headers: {
      "User-Agent": MILI_UA,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`一只鸟接口 HTTP ${resp.status}`);

  const json = await resp.json();
  if (String(json?.status) !== "200") return out;

  for (const group of json.context || []) {
    const shopName = String(group?.shop?.shopName || "").trim();
    const prof = profiles.get(shopName);
    // 只落配置里列出的门店（品牌旗下可能还有没接入的分店）
    if (profiles.size && !prof) continue;
    for (const item of group?.arrangingStudentList || []) {
      const courseName = cleanCourseName(item?.course?.courseName);
      if (!courseName) continue;
      const begin = String(item?.arrangingCourses?.beginDate || "");
      const end = String(item?.arrangingCourses?.endDate || "");
      const hhmm = (iso) => (iso.match(/T(\d{2}:\d{2})/) || [])[1] || "";
      const max = item?.classInfo?.classMax != null ? Number(item.classInfo.classMax) : null;
      const used =
        item?.arrangingCourses?.bookingTotal != null
          ? Number(item.arrangingCourses.bookingTotal)
          : null;
      const teacher = (item?.shopTeacherList || [])[0] || {};
      out.push({
        courseName,
        coach: String(teacher.teacherName || "").trim(),
        _coachAvatar: pickImageUrl(teacher.teacherLongUrl),
        time: `${hhmm(begin)}-${hhmm(end)}`,
        capacity: max ? `${used ?? ""}/${max}` : "",
        status: max && used != null && used >= max ? "已满" : "可预约",
        _bookedNum: used,
        _studioName: shopName,
        _roomName: String(item?.classRoom?.classRoomName || "").trim(),
        _city: prof?.city,
        _address: prof?.address,
        _lat: prof?.lat,
        _lng: prof?.lng,
      });
    }
  }
  return out;
}

/* ─────────────── 舞空云 / HTD（haowan2000.com）抓取 ─────────────── */

/**
 * 舞空云（ws-htd.haowan2000.com）—— HTD 舞蹈工作室在用的小程序 SaaS。
 * - 门店：GET `/api/v1/gym/listGym`（返回 gymId / gymName / address / lon / lat）
 * - 课表：GET `/api/v1/course/getCourseList?queryDate=YYYY-MM-DD&gymId=<id>&courseType=全部类型`
 * - 课程字段：courseName / danceType 舞种 / teacherName 教练 / teacherHeadUrl 头像 /
 *     startDate + startTime + endTime / remainQuota 剩余 / spaceName 教室
 * ⚠ 接口**不返回容量总量**（只有 remainQuota 剩余），所以 capacity / 已约数一律留空，
 *   不要拿 remainQuota 冒充容量 —— 「剩余 3」和「总共 30」是完全不同的信息。
 */
async function crawlWithHaowan(config, date) {
  const { baseUrl = "https://ws-htd.haowan2000.com", gyms } = config.haowan || {};
  if (!Array.isArray(gyms) || !gyms.length) {
    throw new Error("haowan 模式缺少 gyms 配置");
  }

  const dateStr = date.toISOString().slice(0, 10);
  const brandName = (config.studio?.name || "").trim();
  const out = [];
  // 门店档案：当天没课的分店也要留在库里（与嘉禾 / csdsp 同策略）
  out.ensureStudios = gyms
    .filter((g) => g && g.name)
    .map((g) => ({
      name: composeStudioName(brandName, g.name),
      city: g.city,
      address: g.address,
      lat: g.lat,
      lng: g.lng,
    }));

  for (const gym of gyms) {
    const gymId = gym.id != null ? String(gym.id) : "";
    const qs = new URLSearchParams({
      queryDate: dateStr,
      gymId,
      courseType: "全部类型",
    });
    const resp = await fetch(`${baseUrl}/api/v1/course/getCourseList?${qs}`, {
      headers: { "User-Agent": MILI_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`舞空云接口 HTTP ${resp.status}`);

    const json = await resp.json();
    if (json?.code !== 0) continue;

    for (const c of json.data || []) {
      const courseName = cleanCourseName(c.courseName);
      if (!courseName) continue;
      out.push({
        courseName,
        coach: String(c.teacherName || "").trim(),
        _coachAvatar: pickImageUrl(c.teacherHeadUrl),
        time: `${c.startTime || ""}-${c.endTime || ""}`,
        capacity: "",
        status: "可预约",
        // 抓不到已约人数就存 null，不存 0（0 和「不知道」是两回事）
        _bookedNum: null,
        _studioName: composeStudioName(brandName, c.shopName || gym.name),
        _roomName: String(c.spaceName || "").trim(),
        _photoUrl: pickImageUrl(c.coursePicUrl),
        _city: gym.city,
        _address: gym.address,
        _lat: gym.lat,
        _lng: gym.lng,
      });
    }
  }
  return out;
}

/* ─────────────── 青橙科技（qingchengfit.cn）抓取 ─────────────── */

/**
 * 青橙科技（yun.qingchengfit.cn）—— 健身/舞蹈场馆 SaaS（UNLABEL&舞厂牌在用）。
 * - 品牌全部门店：GET `/select/shops/?brand_id=<id>`（含店名 / 地址 / 经纬度）
 * - 课表：GET `/api/mobile/schedules/group/?shop_id=<id>&date=YYYY-MM-DD`
 * - 课程字段：course.name 课名 / course.course_type_tag 舞种 / teacher.username 教练 /
 *     teacher.avatar 头像 / start + end ISO 时间 / max_users 容量 / current_users 已约 /
 *     space.name 教室 / shop.name 门店名
 */
async function crawlWithQingcheng(config, date) {
  const { baseUrl = "https://yun.qingchengfit.cn", shops } = config.qingcheng || {};
  if (!Array.isArray(shops) || !shops.length) {
    throw new Error("qingcheng 模式缺少 shops 配置");
  }

  const dateStr = date.toISOString().slice(0, 10);
  const brandName = (config.studio?.name || "").trim();
  const out = [];
  // 门店档案：当天没课的分店也要留在库里（与嘉禾 / csdsp 同策略）
  out.ensureStudios = shops
    .filter((s) => s && s.name)
    .map((s) => ({
      name: composeStudioName(brandName, s.name),
      city: s.city,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
    }));

  for (const shop of shops) {
    const shopId = String(shop.id || "").trim();
    if (!shopId) continue;
    const qs = new URLSearchParams({ shop_id: shopId, date: dateStr });
    const resp = await fetch(`${baseUrl}/api/mobile/schedules/group/?${qs}`, {
      headers: { "User-Agent": MILI_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`青橙接口 HTTP ${resp.status}`);

    const json = await resp.json();
    if (json?.status !== 200) continue;

    for (const s of json?.data?.schedules || []) {
      const courseName = cleanCourseName(s?.course?.name);
      if (!courseName) continue;
      const max = s.max_users != null ? Number(s.max_users) : null;
      const used = s.current_users != null ? Number(s.current_users) : null;
      // start/end 是 "2026-09-30T11:00:00" 本地墙钟字符串，只取 HH:mm 交给 mapper 解析
      const hhmm = (iso) => (String(iso).match(/T(\d{2}:\d{2})/) || [])[1] || "";
      out.push({
        courseName,
        coach: String(s?.teacher?.username || "").trim(),
        _coachAvatar: pickImageUrl(s?.teacher?.avatar),
        time: `${hhmm(s.start)}-${hhmm(s.end)}`,
        capacity: max ? `${used ?? ""}/${max}` : "",
        status: max && used != null && used >= max ? "已满" : "可预约",
        _bookedNum: used,
        _studioName: composeStudioName(brandName, s?.shop?.name || shop.name),
        _roomName: String(s?.space?.name || "").trim(),
        _photoUrl: pickImageUrl(s.image),
        _remark: s?.course?.course_type_tag ? `舞种：${s.course.course_type_tag}` : null,
        _city: shop.city,
        _address: shop.address,
        _lat: shop.lat,
        _lng: shop.lng,
      });
    }
  }
  return out;
}

/* ─────────────────── 嘉禾舞社（app.jiahewushe.com）抓取 ─────────────────── */

/**
 * 嘉禾舞社（北京起家，跨城连锁）小程序 wx657a98be3f6c70ce 逆向所得：
 * - ⚠ URL 有个隐藏前缀：`baseUrl + "/v" + apiVersion + "/" + 路径`，
 *   即 `https://app.jiahewushe.com/v1.0.0/xxx`（config.js 里 apiVersion:"1.0.0"）。
 *   直接打 `/stores`、`/api/stores` 一律返回「未找到相关服务」。
 * - 门店：GET v1.0.0/stores（13 家：北京 8 + 广州 / 青岛 / 天津 / 邯郸）
 * - 课表：GET v1.0.0/courses → **一次返回全部门店**，按门店分组：
 *   `[{ id, name(门店名), address, longitude, latitude, courses:[ ... ] }]`
 *   课程字段：course_name（"Jazz · 基础"，舞种·难度已拼好）、teacher_names、
 *   time（"12:30-13:30"）、student_number（容量）、student_count（已约）。
 * - ⚠ `date` 参数无效：给 2026-09-28 / 10-01 / 10-05 返回的课程 id 完全一致，
 *   接口实际只给「当天可预约」的课表。所以配置必须 days:1，靠每天刷新覆盖未来，
 *   不能按 nextDays:7 抓（会把同一批课重复写成 7 天）。
 * - 门店跨城，`_city` 从 address 前缀（"北京市"/"广州市"…）推断，
 *   由 importer.js 的 rowOverride 写进 Studio.city。
 */
async function crawlWithJiahe(config, date) {
  const { baseUrl = "https://app.jiahewushe.com/v1.0.0" } = config.jiahe || {};
  const brand = (config.studio?.name || "嘉禾舞社").trim();

  const resp = await fetch(`${baseUrl}/courses`, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`jiahe 接口 HTTP ${resp.status}`);

  const list = await resp.json();
  if (!Array.isArray(list)) throw new Error("jiahe 接口返回格式异常");

  /**
   * 门店清单单独拉一份：/courses 只返回「今天有课」的门店，
   * 当天没排课的门店（如 2026-09 新开的马家堡店）会整个消失在库里 ——
   * 用户翻门店列表时以为没接入。所以这里用 /stores 的全量门店建店，
   * 课为 0 也留一条记录，点进去显示「暂无排课」比查无此店可信。
   * 这个接口失败不影响本轮抓课，静默降级。
   */
  const out = [];
  out.ensureStudios = await fetchJiaheStores(baseUrl, brand);
  for (const store of list) {
    const storeName = String(store.name || "").trim();
    if (!storeName) continue;
    const city = guessCityFromAddress(store.address);

    for (const c of store.courses || []) {
      const courseName = cleanCourseName(c.course_name);
      if (!courseName) continue;

      const max = c.student_number != null ? Number(c.student_number) : null;
      const used = c.student_count != null ? Number(c.student_count) : null;

      out.push({
        courseName,
        coach: String(c.teacher_names || "").trim(),
        time: String(c.time || "").trim(),
        capacity: max ? `${used != null ? Math.max(max - used, 0) : ""}/${max}` : "",
        status: max && used != null && used >= max ? "已满" : "可预约",
        _bookedNum: used,
        _studioName: `${brand}·${storeName}`,
        _city: city,
        _address: String(store.address || "").trim(),
      });
    }
  }
  return out;
}

/**
 * 嘉禾门店档案：GET v1.0.0/stores（13 家，跨北京/广州/青岛/天津/邯郸）。
 * 只用来「建店」，不参与排课。失败返回空数组 —— 门店档案是锦上添花，
 * 不能因为它挂了就让当天的课一条都进不来。
 */
async function fetchJiaheStores(baseUrl, brand) {
  try {
    const resp = await fetch(`${baseUrl}/stores`, {
      headers: { "Content-Type": "application/json; charset=utf-8" },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return [];
    const list = await resp.json();
    if (!Array.isArray(list)) return [];
    return list
      .map((s) => ({
        name: `${brand}·${String(s.store_name || "").trim()}`,
        city: guessCityFromAddress(s.address),
        address: String(s.address || "").trim(),
      }))
      .filter((s) => s.name.length > brand.length + 1);
  } catch {
    return [];
  }
}

/**
 * 从 "北京市海淀区…" / "广州市天河区…" 提取城市名（去掉「市/省」）。
 * ⚠ 匹配不到时必须返回空串：部分门店地址是「长楹天街西区…」这种商圈名开头，
 *    硬截前几字会得到「长楹天」这种假城市；返回空则由 importer 回落到 config.studio.city。
 */
function guessCityFromAddress(addr) {
  const m = String(addr || "").trim().match(/^([\u4e00-\u9fa5]{2,4}?)[市省]/);
  return m ? m[1] : "";
}

/* ───────────── csdsp.com SaaS（王牌嘻帝等，uni-app 多租户）抓取 ───────────── */

/**
 * csdsp.com 是继 iWOD / 菲体云 / 爱舞功 / styd 之后的**又一套舞蹈培训 SaaS**，
 * 逆向自 Mac 微信缓存包 wx5556c123a9c51bc7（外壳 appid wxe2477036d5f43693）。
 *
 * ⚠ 核心机制：不是「一家一个小程序」，而是**一套 uni-app 包 + 后台注入 ext.tenantId**：
 *   app-config.json 的 `ext: { tenantId: "98285824" }` 决定这家是哪家。
 *   所以接入新品牌的唯一门槛是**拿到 tenantId**（从它自己的包里解出来），
 *   拿到之后所有接口完全通用 —— 这点是它比 iWOD 好接的地方。
 *   ⚠ tenantId 不连续（试打 98285825/98285826 全是 500），**无法枚举**，
 *   只能靠解包，别去扫号段。
 *
 * - 网关：`https://gateway.csdsp.com`，接口前缀 `/mp/public/`，**全部免登录**
 * - 租户：  GET /mp/public/tenant?tenantId=X → companyName（"王牌嘻帝"）
 * - 校区：  GET /mp/public/campusList?tenantId=X → deptId/deptName/location/coordinate
 * - 课表：  GET /mp/public/lectureList?tenantId=X&startDate=…&endDate=…
 *   ⭐ **带日期区间一次能拉整周**（实测 7 天 303 节），不像 iWOD 要按天翻页。
 *   ⚠ 不带日期参数会返回全历史（王牌嘻帝 15580 条、17MB+），千万别裸调。
 * - 日期格式 `YYYY-M-D HH:mm:ss`（月日不补零也认）；
 *   另有 schoolTime=YYYY-MM-DD 可只取单日。
 *
 * 课程字段：classesName（⚠ 自带校区前缀，如「五四北宝宝娟抖音舞成人入门」）、
 * teacherName、genreName（Jazz/Choreo/Hiphop…）、campusId、level（"入门"）、
 * startTime/endTime、startDate（"2026/09/28 12:30:00"）、
 * reserveNum（已约）/reserveLimit（上限）/reservable。
 */
async function crawlWithCsdsp(config, date) {
  const { baseUrl = "https://gateway.csdsp.com", tenantId } = config.csdsp || {};
  if (!tenantId) throw new Error("csdsp 配置缺少 tenantId");
  const brand = (config.studio?.name || "").trim();
  // 一个请求拉多少天（0/未设 = 7）。实测 7 天最稳，再长意义不大
  const spanRaw = config.csdsp?.spanDays;
  const span = spanRaw != null ? Math.max(Number(spanRaw) || 7, 1) : 7;

  // 校区档案：作用同嘉禾 —— 当天没课的分店也要留在库里
  const campuses = await fetchCsdspCampuses(baseUrl, tenantId);
  const campusMap = new Map();
  for (const c of campuses) campusMap.set(c.deptId, c);

  const out = [];
  out.ensureStudios = campuses.map((c) => ({
    name: `${brand}·${c.short}`,
    address: c.location,
  }));

  // 本地日期（不能用 toISOString：容器按 UTC 跑会偏移一天）
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const dateStr = `${y}-${m}-${d}`;
  const to = new Date(date.getTime() + (span - 1) * 86400000);
  const toStr = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, "0")}-${String(to.getDate()).padStart(2, "0")}`;
  const qs = new URLSearchParams({
    tenantId: String(tenantId),
    startDate: `${dateStr} 00:00:00`,
    endDate: `${toStr} 23:59:59`,
  });
  const resp = await fetch(`${baseUrl}/mp/public/lectureList?${qs}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`csdsp 课表接口 HTTP ${resp.status}`);
  const list = await resp.json();
  if (!Array.isArray(list?.data)) throw new Error("csdsp 课表返回格式异常");

  for (const lec of list.data) {
    const campus = campusMap.get(String(lec.campusId || ""));
    const branch = campus ? campus.short : "";
    const raw = String(lec.classesName || "").trim();
    if (!raw) continue;
    // 课程名自带校区前缀（「五四北宝宝娟抖音舞成人入门」），剥掉后才是有效信息
    const courseName = stripCampusPrefix(raw, branch);
    const limit = Number(lec.reserveLimit) || 0;
    const used = Number(lec.reserveNum) || 0;
    const full = String(lec.reservable || "0") !== "1" || (limit > 0 && used >= limit);

    out.push({
      courseName,
      coach: String(lec.teacherName || "").trim(),
      time: `${String(lec.startTime || "").trim()}-${String(lec.endTime || "").trim()}`,
      capacity: limit ? `${Math.max(limit - used, 0)}/${limit}` : "",
      status: full ? "已满" : "可预约",
      _bookedNum: used,
      _studioName: `${brand}${branch ? `·${branch}` : ""}`,
      _address: campus ? campus.location : "",
      _remark: [
        lec.genreName ? `舞种：${lec.genreName}` : null,
        lec.level ? `难度：${lec.level}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
      // 每节课自带真实日期，一次跨界请求写回各自那天
      _scheduleDate: normalizeDate(lec.startDate),
    });
  }
  return out;
}

/**
 * 校区档案：GET /mp/public/campusList。
 * 顺手算出 short 名（"五四北校区" → "五四北"），课表名前缀就靠它剥。
 * 失败返回空数组 —— 不阻塞本轮抓课（此时 campusId 反查不到，门店名回落品牌名）。
 */
async function fetchCsdspCampuses(baseUrl, tenantId) {
  try {
    const resp = await fetch(`${baseUrl}/mp/public/campusList?tenantId=${tenantId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return [];
    const list = await resp.json();
    if (!Array.isArray(list?.data)) return [];
    return list.data
      .filter((c) => String(c.deptCategory || "") === "CAMPUS")
      .map((c) => {
        const full = String(c.deptName || "").trim();
        return {
          deptId: String(c.deptId || ""),
          full,
          short: full.replace(/校区$/, "").trim() || full,
          location: String(c.location || "").trim(),
        };
      })
      .filter((c) => c.deptId && c.short);
  } catch {
    return [];
  }
}

/** "五四北宝宝娟抖音舞成人入门" 去掉前缀 "五四北" → "宝宝娟抖音舞成人入门" */
function stripCampusPrefix(name, prefix) {
  if (!prefix) return name;
  if (name.startsWith(prefix) && name.length > prefix.length) {
    return name.slice(prefix.length).trim();
  }
  return name;
}

/** "2026/09/28 12:30:00" → "2026-09-28"；拿不到返回空（外部回落到 _date） */
function normalizeDate(text) {
  const m = String(text || "").trim().match(/(\d{4})[/_-](\d{1,2})[/_-](\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

/* ───────────────────── G-STEPS（api.gsteps.cn）抓取 ───────────────────── */

/**
 * G-STEPS 街舞（北京，自研 Go 后端）小程序 wxdbbcee97b5a718d4 逆向所得：
 * - 域：`https://api.gsteps.cn/v2/`（另有 signin/poster/ai 三个子域，课表只用 v2）
 * - 课表：POST v2/activity/query/fast，**必须 JSON body**（发 form 会报
 *   `invalid character 'm' looking for beginning of value`），免登录可用。
 * - 入参：`start_date` / `end_date`（YYYY-MM-DD，同一天即单日课表）、
 *   `page`、`page_size`。⚠ `page_size` 服务端锁死 20，给 100/500 也只返 20 条，
 *   必须靠 page 递增翻页（北京单日约 832 节 ≈ 42 页）。
 * - ⚠ 传 `studio_id` 无效：返回体里仍会带上别家门店的课。
 *   所以**一次请求就是全平台全城课表**，按返回里的 `studio_name` 分店落库即可。
 * - 课程字段：course_name / teacher_name / course_kind_name（舞种）/ course_level_name（难度）/
 *   start_time（"2026-09-29 09:30:00"）/ duration（分钟）/ classroom / studio_name /
 *   max_member / reserved_count。start_time 未带日期过滤时是 Go 零值 "0001-01-01 00:00:00"。
 * - 门店档案：GET v2/studio/list（免登录，40 家，含 address/latitude/longitude）。
 *
 * ⚠ 门店的**真实城市必须取自门店档案的 city 字段**，不能用 config.studio.city。
 *   G-STEPS 一次请求返回的是全国课表（北京 38 家 + 上海 2 家），若照抄配置里的
 *   城市，上海新天地店、北外滩来福士店会被挂到北京名下——在北京界面出现上海分店。
 */

/** studio_name → 真实城市，6 小时缓存（门店档案不常变，别每轮每店都拉一次） */
let gstepsCityCache = { at: 0, map: new Map() };
const GSTEPS_CITY_TTL_MS = 6 * 60 * 60 * 1000;

/** "北京市"/"上海市" → "北京"/"上海"（库里 City.name 不带行政后缀） */
function normalizeCityName(raw) {
  return String(raw || "").trim().replace(/(特别行政区|自治州|地区|市|县)$/, "");
}

async function loadGstepsCityMap(baseUrl) {
  const now = Date.now();
  if (gstepsCityCache.map.size && now - gstepsCityCache.at < GSTEPS_CITY_TTL_MS) {
    return gstepsCityCache.map;
  }
  try {
    const resp = await fetch(`${baseUrl}/studio/list`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`gsteps 门店档案 HTTP ${resp.status}`);
    const body = await resp.json();
    const list = Array.isArray(body?.res) ? body.res : [];
    const map = new Map();
    for (const s of list) {
      const name = String(s.name || "").trim();
      if (!name) continue;
      map.set(name, normalizeCityName(s.city || s.province || ""));
    }
    if (map.size) gstepsCityCache = { at: now, map };
    return map;
  } catch (e) {
    // 拉不到就用旧缓存（首次为空 → 回退到配置城市），不让整轮抓取失败
    return gstepsCityCache.map;
  }
}

async function crawlWithGsteps(config, date) {
  const { baseUrl = "https://api.gsteps.cn/v2" } = config.gsteps || {};

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const dateStr = `${y}-${m}-${d}`;

  const brand = (config.studio?.name || "G-STEPS").trim();
  const fallbackCity = config.studio?.city || "";
  const cityMap = await loadGstepsCityMap(baseUrl);

  const out = [];
  let page = 1;
  // 单日上限 60 页（1200 节），足够覆盖全城；翻到返回不足 20 条即结束
  while (page <= 60) {
    const resp = await fetch(`${baseUrl}/activity/query/fast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mini_type: 1,
        visiting_appid: "wxdbbcee97b5a718d4",
        start_date: dateStr,
        end_date: dateStr,
        page,
        page_size: 20,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) throw new Error(`gsteps 接口 HTTP ${resp.status}`);

    const body = await resp.json();
    if (body?.code !== 0) break;

    const list = body?.res?.list || [];
    if (!list.length) break;

    for (const c of list) {
      const courseName = cleanCourseName(c.course_name);
      if (!courseName) continue;

      // start_time: "2026-09-29 09:30:00" → "09:30"，结束时间靠 duration 推算
      const start = String(c.start_time || "").slice(11, 16);
      if (!/^\d{2}:\d{2}$/.test(start)) continue; // 零值/脏数据直接跳过
      const dur = Number(c.duration || 0);
      const end = dur ? addMinutes(start, dur) : "";

      const max = c.max_member != null ? Number(c.max_member) : null;
      const used = c.reserved_count != null ? Number(c.reserved_count) : null;

      const studioName = String(c.studio_name || "").trim();
      // 真实城市优先取门店档案；拿不到才回退到配置城市
      const realCity = cityMap.get(studioName) || fallbackCity;

      out.push({
        courseName,
        coach: String(c.teacher_name || "").trim(),
        time: end ? `${start}-${end}` : start,
        capacity: max ? `${used != null ? Math.max(max - used, 0) : ""}/${max}` : "",
        status: max && used != null && used >= max ? "已满" : "可预约",
        _bookedNum: used,
        _studioName: `${brand}·${studioName}${realCity ? `（${realCity}）` : ""}`,
        // 行级覆盖城市：不传的话上海分店会全部落进北京
        ...(realCity ? { _city: realCity } : {}),
        _remark: [c.course_kind_name, c.course_level_name].filter(Boolean).join("·"),
      });
    }

    if (list.length < 20) break;
    page += 1;
    await sleep(80);
  }
  return out;
}

/** "09:30" + 60 → "10:30"（跨天按 24h 取模，课表不会跨天，够用） */
function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/* ─────────────────── Fox 舞蹈（admin.foxdance.com.cn）抓取 ─────────────────── */

/**
 * Fox 舞蹈厂牌（广州，自研 PHP/ThinkPHP 后端）小程序 wx1c9690589dff339b 逆向所得：
 * - baseUrl 必须带 `/index.php` 入口：`https://admin.foxdance.com.cn/index.php/api`
 *   直接打 `https://admin.foxdance.com.cn/api/...` 会被 nginx 302 到 /index.html（前端页），拿不到 JSON。
 * - 全部接口是 POST + `application/x-www-form-urlencoded`，不是 JSON。
 * - 门店：POST /index/store  id=<门店ID>  → data = { id, name, address, latitude, longitude }
 *   **没有「门店列表」接口**：只能按 id 枚举（实测 1..40，其中 15/18/19/20 空缺，
 *   有效 16 家，部分店已停业返回「获取门店失败」）。
 * - 课表：POST /index/store_courses  id=<门店ID>&page=<页>&date=YYYY-MM-DD
 *   免登录可用；date 省略＝当天，给值可抓未来任意一天。分页 per_page=5，靠 last_page 判停。
 * - 课程字段：course.name（"Jazz精品课课程————汝汝"）、teacher.name、dance_name（舞种）、
 *   level_name（难度）、start_time/end_time（"2026-09-28 11:30"）、status。
 *   课名尾部「————老师名」是重复的，剥掉后单独用 teacher.name 展示。
 */
async function crawlWithFoxdance(config, date) {
  const {
    baseUrl = "https://admin.foxdance.com.cn/index.php/api",
    shops,
  } = config.foxdance || {};

  const targets = Array.isArray(shops) && shops.length ? shops : [];
  if (!targets.length) throw new Error("foxdance 模式缺少 shops 配置");

  // 本地日期字符串（不能用 toISOString，会按 UTC 偏移一天）
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const dateStr = `${y}-${m}-${d}`;

  const postForm = async (pathname, params) => {
    const resp = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`foxdance 接口 HTTP ${resp.status}`);
    return resp.json();
  };

  const out = [];
  for (const shop of targets) {
    let page = 1;
    let lastPage = 1;
    // 每店最多翻 8 页（per_page=5，即 40 节），足够覆盖单日课表
    while (page <= lastPage && page <= 8) {
      const body = await postForm("/index/store_courses", {
        id: shop.id,
        page,
        date: dateStr,
      });
      // code 非 1 视为该店当天无课/已停业，不抛错，避免整条链断掉
      if (body?.code !== 1) break;

      const data = body?.data || {};
      lastPage = Number(data.last_page || 1);

      for (const c of data.data || []) {
        const rawName = String(c?.course?.name || "").trim();
        // 剥掉课名尾部的「————老师名」（平台自己把老师名拼进了课名）
        const courseName = cleanCourseName(rawName.replace(/[—–\-]{2,}.*$/, ""));
        if (!courseName) continue;

        // ⚠ 字段格式不一致：不带 date 参数时返回 "2026-09-28 11:30"，带 date 时只有 "11:30"。
        // 两种都取末 5 位即 "HH:mm"，避免 slice(11,16) 在短格式上截出空串。
        const startTime = String(c.start_time || "").slice(-5);
        const endTime = String(c.end_time || "").slice(-5);
        const time = startTime && endTime ? `${startTime}-${endTime}` : "";

        const max = c.maximum_reservation != null ? Number(c.maximum_reservation) : null;
        const used = c.appointment_number != null ? Number(c.appointment_number) : null;
        const capacity = max ? `${used != null ? max - used : ""}/${max}` : "";

        out.push({
          courseName,
          coach: String(c?.teacher?.name || "").trim(),
          // styd 的 teacher 是对象，头像字段名各家不一，都试一遍
          _coachAvatar: pickImageUrl(
            c?.teacher?.avatar || c?.teacher?.avatar_url || c?.teacher?.pic,
          ),
          time,
          capacity,
          status: max && used != null && used >= max ? "已满" : "可预约",
          _bookedNum: used,
          _studioName: (shop.name || config.studio?.name || "").trim(),
          // 舞种 + 难度拼进备注，前端可按需展示
          _remark: [c.dance_name, c.level_name].filter(Boolean).join("·"),
        });
      }
      page += 1;
      if (page <= lastPage) await sleep(120);
    }
  }
  return out;
}

/* ───────────────────────── 飞兔 FitToo（feiyuntoo.cn）抓取 ───────────────────────── */

/**
 * 飞兔约课 / FitToo（api.feiyuntoo.cn）—— 第五套平台，广州 LightDance 在用。
 *
 * 逆向要点（2026-09-28 由 LightDance 小程序 wxapkg 解密 + 接口探测获得）：
 * - **brandId 在小程序 ext 里**：app-config.json → ext.encryptedBrandId（5 位短码，如 o8ysd）。
 *   这是每个场馆的唯一标识，也是「扫码进小程序」分发场馆的依据。
 * - 免登录，但 brandId 必须放在 **HTTP header**（放 body 一律 70012「请扫场馆二维码进入小程序」）：
 *     brandId: <encryptedBrandId>、appId: <小程序 appId>、appType: 2、
 *     content-type: application/json（POST 才有）、xdversion: <小程序版本号>
 *   ⚠ 接口是 Spring Boot，GET 传参会 500，一律用 POST + JSON body。
 * - 门店清单：POST /api/common/shop/listAll
 *     → data[] = [{ id, shopName, lng, lat, address, contactPhone }]
 * - 课表：POST /api/classes/list-new
 *     body { shopIds, startDate:"YYYY-MM-DD", currentPage:0, pageSize:20, env:"wx" }
 *     → data.list[] = [{ classId, className, shopName, classroomName, difficult,
 *          startTime:"19:00", endTime:"20:30", teacherName, startDate,
 *          enrollNumber（已约）, holdNumber（上限）, lackNum, minBookNum, status }]
 *     ⚠ currentPage 从 0 开始；date 参数名是 startDate（不是 date）。
 * - difficult 是星数文案 "⭐⭐⭐"：1 星入门 / 2 星提高 / 3 星及以上高级。
 * - 需要登录的接口（chooseBrand / getBrandList 等）一律 5000，我们不碰。
 *
 * @param {object} config 抓取配置（含 config.feiyuntoo）
 * @param {Date} date 抓取起始日期
 * @returns {Promise<Array>} 原始条目
 */
async function crawlWithFeiyuntoo(config, date) {
  const {
    baseUrl = "https://api.feiyuntoo.cn",
    brandId,
    appId,
  } = config.feiyuntoo || {};
  if (!brandId) throw new Error("feiyuntoo 配置缺少 brandId（ext.encryptedBrandId）");
  if (!appId) throw new Error("feiyuntoo 配置缺少 appId（小程序 appId）");

  const headers = {
    brandId: String(brandId),
    appId: String(appId),
    appType: "2",
    "content-type": "application/json",
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  };
  const post = async (path, payload) => {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ env: "wx", ...payload }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`飞兔接口 ${path} HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || json.success === false || (json.code && String(json.code) !== "200")) {
      throw new Error(`飞兔接口 ${path} 返回异常: ${json?.msg || json?.code || "unknown"}`);
    }
    return json.data;
  };

  // ── 门店档案：当天没课的分店也要留在库里（与嘉禾/csdsp 同策略）
  const shops = await post("/api/common/shop/listAll", {});
  const shopList = Array.isArray(shops) ? shops : [];
  if (!shopList.length) throw new Error("飞兔门店列表为空，检查 brandId/appId 是否有效");

  const out = [];
  out.ensureStudios = shopList.map((s) => ({
    name: String(s.shopName || "").trim(),
    address: String(s.address || "").trim(),
  }));

  const span = Math.max(Number(config.feiyuntoo?.spanDays) || 7, 1);
  for (let i = 0; i < span; i += 1) {
    const day = new Date(date.getTime() + i * 86400000);
    const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(
      day.getDate()
    ).padStart(2, "0")}`;

    for (const shop of shopList) {
      const shopId = String(shop.id ?? shop.shopId ?? "");
      if (!shopId) continue;
      let currentPage = 0;
      let hasMore = true;
      while (hasMore && currentPage < 10) {
        const data = await post("/api/classes/list-new", {
          shopIds: shopId,
          startDate: dateStr,
          currentPage,
          pageSize: 50,
        });
        const list = Array.isArray(data?.list) ? data.list : [];
        for (const c of list) {
          const courseName = cleanCourseName(c.className);
          if (!courseName) continue;
          const limit = Number(c.holdNumber) || 0;
          const used = Number(c.enrollNumber) || 0;
          const full = limit > 0 && used >= limit;
          out.push({
            courseName,
            coach: String(c.teacherName || "").trim(),
            time: `${String(c.startTime || "").trim()}-${String(c.endTime || "").trim()}`,
            capacity: limit ? `${Math.max(limit - used, 0)}/${limit}` : "",
            status: full ? "已满" : "可预约",
            _bookedNum: used,
            _studioName: String(c.shopName || shop.shopName || "").trim(),
            _roomName: String(c.classroomName || "").trim(),
            _address: String(shop.address || "").trim(),
            _difficulty: mapFeiyuntooDifficulty(c.difficult),
            _scheduleDate: normalizeDate(c.startDate) || dateStr,
          });
        }
        hasMore = Boolean(data?.hasMore) && list.length > 0;
        currentPage += 1;
        if (hasMore) await sleep(120);
      }
    }
  }
  return out;
}

/** 飞兔难度（星星文案）→ 统一枚举 */
function mapFeiyuntooDifficulty(text) {
  const stars = (String(text || "").match(/[⭐★]/g) || []).length;
  if (!stars) return null;
  if (stars <= 1) return "BEGINNER";
  if (stars === 2) return "INTERMEDIATE";
  return "ADVANCED";
}

/* ───────────────────────── 爱舞功（aiwugong.cn）抓取 ───────────────────────── */

/**
 * 爱舞功 / 舞十（wushi.api.aiwugong.cn，Yii2 后端）SaaS 约课系统
 * —— 与 iWOD、菲体云并列的第三套平台，深圳多家舞室在用（CLAP dance studio 等）。
 *
 * 逆向要点（2026-09-27 由 CLAP dance studio 小程序包解密 + 接口探测获得）：
 * - 免登录课表接口 POST /Applets/course/index-not-login.html
 *     参数 host=<小程序 appId>、brand_id=<品牌ID>、date=YYYY-MM-DD、page=<页码>
 *     → bug.data[] = [{ store_id, store:"门店名", course:[...] }]，按门店分组
 * - **brand_id 是钥匙**：不给它就 500（SQL 里 FIELD() 参数为空）。缺 host 时它只用来
 *   走默认分支，实际过滤靠 brand_id，所以同一平台可以一个 host 抓所有品牌。
 * - 品牌可枚举：POST /Applets/login/brand.html（host + brand_id）
 *     → brand_name / slogan / address / city / synopsis，brand_id 为小整数
 *     据此可批量发现平台上的舞室，见 capture/scan_aiwugong_brands.mjs
 * - 课程字段：name 课名 / time "14:00~15:30" / teacher.nickname 教练 /
 *     difficulty "提高班" / classroom 教室 / status_dec "紧张" / is_open_reserve 是否开放预约
 * - 品牌开关 notlogin_isshowcourse=1 时未登录才看得到课表
 *
 * @param {object} config 抓取配置（含 config.aiwugong）
 * @param {Date} date 要抓取的日期
 * @returns {Promise<Array>} 原始条目（含 _studioName 门店名、_difficulty 难度）
 */
async function crawlWithAiwugong(config, date) {
  const { baseUrl = "https://wushi.api.aiwugong.cn", host, brandId } = config.aiwugong || {};
  if (!brandId) throw new Error("aiwugong 模式缺少 brandId 配置");
  if (!host) throw new Error("aiwugong 模式缺少 host 配置");

  const dateStr = date.toISOString().slice(0, 10);
  const out = [];

  // 接口按门店分组返回，all 可能超过一页（limit=40），逐页取到 allPage
  for (let page = 1; page <= 20; page++) {
    const resp = await fetch(`${baseUrl}/Applets/course/index-not-login.html`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      },
      body: new URLSearchParams({
        host: String(host),
        brand_id: String(brandId),
        date: dateStr,
        page: String(page),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`爱舞功接口 HTTP ${resp.status}`);

    const json = await resp.json();
    if (json.code !== 0) {
      throw new Error(`爱舞功接口返回异常: ${json.message || json.msg || "code=" + json.code}`);
    }

    const payload = json.bug || {};
    for (const store of payload.data || []) {
      // store 形如 "DanceStar | 江桥万达店"，也可能只有门店名
      // 只取最后一段当分店名，品牌名统一用配置里的（比接口里的更干净、带品牌自称）
      const branchName = String(store.store || "").split("|").pop().trim();
      for (const c of store.course || []) {
        const courseName = cleanCourseName(c.name);
        if (!courseName) continue;
        out.push({
          courseName,
          coach: String(c.teacher?.nickname || c.teacher?.name || "").trim(),
          // 爱舞功的 teacher 是对象，头像就在 teacher.avatar
          _coachAvatar: pickImageUrl(c.teacher?.avatar),
          time: String(c.time || "").replace("~", "-"),
          capacity: "",
          status: c.is_open_reserve === 0 || c.status_dec === "已满" ? "已满" : "可预约",
          // 品牌名 + 分店名。只写分店名会出现「宝安中心店」这种看不出是谁的店，
          // 而且不同品牌的同名分店（7 家「大学城店」）会按店名被合并成同一条记录。
          _studioName: composeStudioName(config.studio?.name, branchName),
          _roomName: String(c.classroom || "").trim(),
          _difficulty: mapAiwugongDifficulty(c.difficulty),
          _remark: c.curriculum_name ? `课程类型：${c.curriculum_name}` : null,
        });
      }
    }

    const allPage = Number(payload.allPage) || 1;
    if (page >= allPage) break;
  }
  return out;
}

/** 爱舞功难度文案 → 统一枚举（入门班 / 提高班 / 专业班 / 大师班） */
function mapAiwugongDifficulty(text) {
  const t = String(text || "");
  if (/入门|基础|初级/.test(t)) return "BEGINNER";
  if (/中级|提高/.test(t)) return "INTERMEDIATE";
  if (/高级|专业|大师|进阶/.test(t)) return "ADVANCED";
  if (/全|不限/.test(t)) return "ALL_LEVELS";
  return null;
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
        // 1MILLION 只有老师头像这一个图，课程封面和教练头像共用它
        _photoUrl: s.teacher?.[0]?.teacher_meta?.img_face_url || "",
        _coachAvatar: pickImageUrl(s.teacher?.[0]?.teacher_meta?.img_face_url),
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
function justjerkEntriesToRaw(parsed, studioLabel, branchLabel, branchUrl) {
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
      // 各校区有自己的课表页，作为该店的官网入口（海外店没有小程序可跳）
      _officialUrl: branchUrl || null,
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
    rows.push(...justjerkEntriesToRaw(parsed, studioLabel, br.label, br.url));
  }

  return rows;
}

/* ───────────────────────── rawgraphy（韩国本土预约平台）抓取 ───────────────────────── */

const RAWGRAPHY_BASE = "https://rawgraphy.com";
// 平台 lessons 数组里给出的真实时长（分钟）。timeTable 只有栅格，没有 duration，
// 用它做缺省值，再用「同日下一节课的间隔」修正（见 inferDuration）。
const RAWGRAPHY_DEFAULT_DURATION_MIN = 75;

/** 从 RSC 载荷里取出某个 key 之后的第一个完整 JSON 数组 */
function extractJsonArrayAfter(text, key) {
  const start = text.indexOf(key);
  if (start === -1) return null;
  const arrStart = text.indexOf("[", start);
  if (arrStart === -1) return null;
  let depth = 0;
  for (let i = arrStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // 跳过整个字符串（含转义）
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(arrStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 平台在 lessons 数组里把时间写成 "2026-09-26T18:00:00.000Z"，
 * 但这个 Z 是错的 —— 它其实是首尔（UTC+9）的墙上时间：
 * 同一条数据的 description 写的是 "2026.09.26(토) 오후 6:00"。
 * 所以这里只能按字符串取字段，不能用 new Date() 解析（会被本地时区再偏移一次）。
 */
function parseRawgraphyDateTime(value) {
  const iso = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (iso) {
    return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, minutes: Number(iso[4]) * 60 + Number(iso[5]) };
  }
  const dotted = String(value || "").match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (dotted) {
    return {
      date: `${dotted[1]}-${dotted[2]}-${dotted[3]}`,
      minutes: Number(dotted[4]) * 60 + Number(dotted[5]),
    };
  }
  return null;
}

const padHM = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * 推断单节课时长：优先用同日下一节课的间隔（限 45–120 分钟），
 * 否则回落到平台默认 75 分钟。
 */
function inferDuration(sortedMinutes, index) {
  const next = sortedMinutes[index + 1];
  if (next == null) return RAWGRAPHY_DEFAULT_DURATION_MIN;
  const gap = next - sortedMinutes[index];
  if (gap >= 45 && gap <= 120) return gap;
  return RAWGRAPHY_DEFAULT_DURATION_MIN;
}

/**
 * 韩国 rawgraphy.com（로우그래피）平台抓取。
 *
 * 技术路线：
 * - 站点是 Next.js App Router，课表不在 HTML 里，而在 RSC 飞行载荷中。
 *   请求头带 `RSC: 1` 即可拿到精简版载荷（约 39KB，比 230KB 的 HTML 小得多）。
 * - 载荷里有两个数据源，用途不同：
 *     timeTable.cells  → **整周课表**（周一~周日），只有教练名，是主数据源；
 *     lessons[]        → 仅"当前可报名"的 1~2 天，但带 genre / duration，
 *                        用作按 lesson.id 匹配的补充信息。
 * - cell 结构：{ column, row, length, lesson: { id, title, thumbnailUrl, startDate } }
 *     column 0 是时间轴（只有 time 字段，没有 lesson）；column >= 1 是星期列。
 *
 * ⚠ 已知的坑：
 *   1. startDate 的 Z 是假 UTC，实际是首尔时间（详见 parseRawgraphyDateTime）；
 *   2. timeTable 没有课程名也没有时长，课程名按平台自己的命名习惯拼成 "<教练> Class"；
 *   3. 时长靠同日相邻课次间隔推断，拿不到时回落 75 分钟。
 *
 * @param {object} config 抓取配置（含 config.rawgraphy.studioId）
 * @returns {Promise<Array>} 原始条目
 */
async function crawlWithRawgraphy(config, _date) {
  const { studioId } = config.rawgraphy || {};
  if (!studioId) throw new Error("rawgraphy 模式缺少 studioId");

  const resp = await fetch(`${RAWGRAPHY_BASE}/studios/${studioId}`, {
    headers: { "User-Agent": UA, RSC: "1", Accept: "text/x-component" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`rawgraphy studio ${studioId} HTTP ${resp.status}`);
  const body = await resp.text();

  // 整周课表（主数据源）
  const cells = extractJsonArrayAfter(body, '"cells"');
  if (!Array.isArray(cells)) throw new Error(`rawgraphy studio ${studioId} 未找到 timeTable.cells`);

  // 可报名课次（补充 genre / duration / 真实课名），按 id 建索引
  const lessons = extractJsonArrayAfter(body, '"lessons"') || [];
  const lessonById = new Map();
  for (const l of lessons) {
    if (l && l.id != null) lessonById.set(l.id, l);
  }

  const studioName = config.studio?.name || `rawgraphy #${studioId}`;
  const byDate = new Map(); // date -> [{ minutes, cell }]

  for (const cell of cells) {
    const lesson = cell?.lesson;
    if (!lesson?.startDate) continue; // column 0 是时间轴，没有 lesson
    const dt = parseRawgraphyDateTime(lesson.startDate);
    if (!dt) continue;
    if (!byDate.has(dt.date)) byDate.set(dt.date, []);
    byDate.get(dt.date).push({ minutes: dt.minutes, cell });
  }

  const rows = [];
  for (const [date, list] of byDate) {
    list.sort((a, b) => a.minutes - b.minutes);
    list.forEach((item, index) => {
      const { cell } = item;
      const lesson = cell.lesson;
      const extra = lessonById.get(lesson.id);
      const coach = (lesson.title || "").trim();
      // 平台自己的课程命名就是 "<教练> Class"，命中 lessons 时用它的真实课名
      const courseName = extra?.title || (coach ? `${coach} Class` : "");
      if (!courseName) return;

      const duration = extra?.duration || inferDuration(list.map((x) => x.minutes), index);
      const startMin = item.minutes;
      const endMin = startMin + duration;

      const remarkParts = [];
      if (extra?.label?.genre) remarkParts.push(`风格：${extra.label.genre}`);
      if (extra?.label?.type) remarkParts.push(`类型：${extra.label.type}`);

      rows.push({
        courseName,
        coach,
        time: `${padHM(startMin)}-${padHM(endMin)}`,
        capacity: "",
        status: extra?.label?.isEnded ? "已结束" : "可预约",
        _studioName: studioName,
        _scheduleDate: date,
        _photoUrl: lesson.thumbnailUrl || extra?.thumbnailUrl || "",
        _remark: remarkParts.join(" / ") || null,
      });
    });
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

/* ───────────────────────── 魔方约课（yqdicloud.com）抓取 ───────────────────────── */

/**
 * 魔方约课（saas.yqdicloud.com）SaaS 约课系统
 * —— 2026-10-08 由成都 11A DANCE 的小程序包解密 + 接口探测获得。
 *
 * ⭐ 最重要的一条：「只有正式会员可以查看课表」是**前端画出来的墙**，
 *    课表接口本身完全免登录（和咪哩约课一样，不是闻道软件那种真墙）。
 *    拿真机复现时，未登录照样能拿到全部课程 + 真实已约人数。
 *
 * 逆向要点：
 * - 租户标识 tenantId **可以用小程序 appId 换**，免登录：
 *     GET /system/client/getAppParams?appId=<appId> → { tenantId, clientId, grantType }
 *     （小程序端也是这么初始化的，结果缓存 7 天，见包里的 app_dynamic_config）
 *   ⚠ 这条比其它平台省事得多：不抓包也能定位 tenantId，只要有 appId。
 * - 门店清单：GET /dance/home/getStoreList?tenantId=<T>
 *     → [{ id, name, address, phone, longitude, latitude, description, img, status }]
 * - 课表：GET /dance/home/list?tenantId=<T>&storeId=<S>&time=YYYY-MM-DD
 *     → [{ id, danceCourseName, teacherInfoName, teacherInfoPhoto,
 *          startTime "14:30", endTime "15:50", scheduleDate, limitPeople 容量,
 *          applyPeople 已约, roomName, difficult, cateName, status, previewPoster }]
 *   ⚠ 参数名是 **time**（不是 date）—— 传 date 会报
 *     "Required request parameter 'time' ... is not present"，被误当成接口不可用。
 *   ⚠ tenantId 走 **query**；放进 header 会 500（"数据错误，请重新进入小程序查看"）。
 *   ⚠ 其余 /dance/** 接口（courseReservation/courseList、getCourseCateList…）都要 token，
 *     只有 home/list 与 getStoreList 在免登录白名单里（包里的 isTokenNeedless）。
 * - `applyPeople` = 已约、`limitPeople` = 容量（与菲体云/styd 同向，**不是** iWOD 那种反向语义）。
 *   实测 2026-10-08 18:30 JAZZ 25/25（满）、20:00 23/25，交叉验证通过。
 * - ⚠ 课表的日期口径（两次实测，别被误导）：
 *     ① 接口**只返回「今天及以后」**的排课；过去的日期一律返回空数组。
 *        所以**绝不能**用这个接口判断「这门课/这家店以前有没有课」，
 *        也别把某天的空结果当成「店家那天没排课」——先确认那天不是过去。
 *        （曾把 10-06/10-07 的空当成「国庆空档」，其实是那两天已经过去了。）
 *     ② 排课是**成块**发布的，块可以甩到很远处：10-08 那天实测能看到 10-08~10-11；
 *        而 09-30 那天同一接口就能看到 10-08~10-11（**8~11 天以外**），
 *        中间 10-06/10-07 没有任何数据。
 *     结论：窗口必须 ≥ 11 天，配置里取 14 天。按 7 天抓的后果是——
 *     在你「看见」远处那一块之前，页面会连续好几天显示这家店没课。
 *     判「这家店没课」同样要跨天采样，不能只看今天。
 * - ⭐ `previewPoster` 是**课程预告片**，不是封面图：每节课一条独立的 .mp4 直链
 *   （2026-10-08 实测 32 节课 → 8 个 URL、0 复用），而且**公开且不过期**
 *   （HEAD 实测 200 / video/mp4 / `Cache-Control: max-age=93312000` ≈ 3 年）。
 *   → 可以直接落进 `Schedule.videoRef`，详情页 `<video>` 原生播，**不需要回源**。
 *   这与菲体云（腾讯云点播签名 1 小时，只能存「取址」+ 按需回源）完全相反，
 *   也正是 videoRef 从 VARCHAR(64) 放宽到 VARCHAR(512) 的直接原因（直链 75 字符）。
 *   ⚠ 字段名叫 poster 却装视频：当封面塞进 _photoUrl 只会渲染成裂图。
 *     故按扩展名分流 —— 是视频进 _videoRef，真是图片才进 _photoUrl
 *     （该平台本没有课程图，若某个租户传了图，反倒白捡一个封面）。
 *
 * @param {object} config 抓取配置（含 config.mofang）
 * @param {Date} date 抓取起始日期
 * @returns {Promise<Array>} 原始条目
 */
async function crawlWithMofang(config, date) {
  const baseUrl = (config.mofang?.baseUrl || "https://saas.yqdicloud.com").replace(/\/$/, "");
  const appId = config.mofang?.appId;
  let tenantId = config.mofang?.tenantId;

  const get = async (path) => {
    const resp = await fetch(`${baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`魔方约课接口 ${path} HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || Number(json.code) !== 200) {
      throw new Error(`魔方约课接口 ${path} 返回异常: ${json?.msg || json?.code || "unknown"}`);
    }
    return json.data;
  };

  // tenantId：配置里写死优先；没写就用 appId 换（免登录，结果进程内缓存）
  if (!tenantId) {
    if (!appId) throw new Error("mofang 配置缺少 tenantId 或 appId");
    tenantId = await resolveMofangTenant(baseUrl, appId);
  }
  if (!tenantId) throw new Error("魔方约课 tenantId 解析失败");

  const stores = await get(`/dance/home/getStoreList?tenantId=${encodeURIComponent(tenantId)}`);
  const storeList = Array.isArray(stores) ? stores : [];
  if (!storeList.length) throw new Error("魔方约课门店列表为空，检查 tenantId 是否有效");

  // 门店名规范：单店配置用配置里的名字（带城市/商圈后缀，便于用户辨认），
  // 多店用「品牌·分店」拼（与爱舞功同规则，避免不同品牌的同名分店被合并）。
  const storeName = (s) => {
    const raw = String(s.name || "").trim();
    if (storeList.length === 1 && config.studio?.name) return config.studio.name;
    return composeStudioName(config.studio?.name || raw, raw) || raw;
  };

  const out = [];
  out.ensureStudios = storeList.map((s) => ({
    name: storeName(s),
    address: String(s.address || "").trim(),
    lat: Number(s.latitude) || null,
    lng: Number(s.longitude) || null,
    contact: String(s.phone || "").trim() || null,
  }));

  // ⛔ 别直接用 Number()：Number(null) === 0、Number("") === 0。
  //    上游「没给这个字段」会被静默当成「已约 0 人」，正好违反 mapper 的约定
  //    （bookedNum 存 null 才是「不知道」，0 是「确认没人约」）。
  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const span = Math.max(Number(config.mofang?.spanDays) || 4, 1);
  for (let i = 0; i < span; i += 1) {
    const day = new Date(date.getTime() + i * 86400000);
    const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(
      day.getDate()
    ).padStart(2, "0")}`;

    for (const store of storeList) {
      const storeId = String(store.id || "");
      if (!storeId) continue;
      const rows = await get(
        `/dance/home/list?tenantId=${encodeURIComponent(tenantId)}&storeId=${encodeURIComponent(
          storeId
        )}&time=${dateStr}`
      );
      for (const r of Array.isArray(rows) ? rows : []) {
        const courseName = cleanCourseName(r.danceCourseName);
        if (!courseName) continue;
        const limit = num(r.limitPeople) || 0;
        const usedNum = num(r.applyPeople);
        // previewPoster 装的是课程预告片（.mp4 直链，公开且不过期，见函数头注释）。
        // 字段名叫 poster，所以按扩展名分流，别因为名字里有 poster 就当图片用。
        // ⚠ 两处都只认**绝对 URL**：videoRef / coursePicUrl 最终会原样交给小程序的
        //   <video> / <image>，相对路径在那边没有 base 可拼，只会得到一块黑屏或裂图。
        const media =
          String(r.previewPoster || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)[0] || "";
        const isVideo = MOFANG_VIDEO_RE.test(media); // 该正则自带 http(s):// 前缀锚
        const isImageUrl = /^https?:\/\//i.test(media) && !isVideo;
        out.push({
          courseName,
          coach: String(r.teacherInfoName || "").trim(),
          time: `${String(r.startTime || "").trim()}-${String(r.endTime || "").trim()}`,
          // 「剩余/容量」口径：已约人数单独走 _bookedNum，别让下游从字符串反推
          capacity: limit ? `${Math.max(limit - (usedNum || 0), 0)}/${limit}` : "",
          status: limit && usedNum != null && usedNum >= limit ? "已满" : "可预约",
          _bookedNum: usedNum,
          _coachAvatar: pickImageUrl(r.teacherInfoPhoto),
          _studioName: storeName(store),
          _roomName: String(r.roomName || "").trim() === "-" ? "" : String(r.roomName || "").trim(),
          _address: String(store.address || "").trim(),
          _city: config.studio?.city,
          _lat: Number(store.latitude) || null,
          _lng: Number(store.longitude) || null,
          _difficulty: mapMofangDifficulty(r.difficult),
          // 视频进 _videoRef（落 Schedule.videoRef，详情页按需播）；
          // 只有「确实是绝对 URL 的图片」才进 _photoUrl，脏值两边都不进。
          _photoUrl: isImageUrl ? media : null,
          _videoRef: isVideo ? media : null,
          _remark: String(r.cateName || "").trim() || null,
          _scheduleDate: normalizeDate(r.scheduleDate) || dateStr,
        });
      }
      if (storeList.length > 1) await sleep(120);
    }
  }
  return out;
}

/** tenantId 解析结果的进程内缓存（同一个 appId 不用反复换） */
const mofangTenantCache = new Map();

async function resolveMofangTenant(baseUrl, appId) {
  if (mofangTenantCache.has(appId)) return mofangTenantCache.get(appId);
  const resp = await fetch(
    `${baseUrl}/system/client/getAppParams?appId=${encodeURIComponent(appId)}`,
    { signal: AbortSignal.timeout(20000) }
  );
  if (!resp.ok) throw new Error(`魔方约课 getAppParams HTTP ${resp.status}`);
  const json = await resp.json();
  // 校验 code：服务端在 appId 无效时返回 {code:500,msg:"数据错误"}，data 为 null。
  // 不看 code 就会静默返回 null，最后报成含糊的「tenantId 解析失败」，排查时白绕一圈。
  if (!json || Number(json.code) !== 200) {
    throw new Error(
      `魔方约课 getAppParams 返回异常（appId=${appId}）: ${json?.msg || json?.code || "unknown"}`
    );
  }
  const tenantId = json?.data?.tenantId ? String(json.data.tenantId) : null;
  if (!tenantId) throw new Error(`魔方约课 getAppParams 没返回 tenantId（appId=${appId}）`);
  mofangTenantCache.set(appId, tenantId);
  return tenantId;
}

/**
 * 判断 previewPoster 里那条 URL 是不是视频。
 * ⚠ 必须带协议前缀一起校验：上游「没有预告片」时给的是空串而不是 null，
 *   只测扩展名会把 undefined/相对路径也算成视频。
 */
const MOFANG_VIDEO_RE = /^https?:\/\/\S+\.(mp4|mov|m4v|webm)(\?\S*)?$/i;

/**
 * 魔方约课的难度是数字（实测只出现 0/2/4，0 = 店家没设）。
 * 本轮样本里「JAZZ入门」= 2、常规课 = 4 → 按 2 一档换算。
 * ⚠ 样本只有一家店，等接入第二家再校正；判不准的宁可不标（null）。
 */
function mapMofangDifficulty(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 2) return "BEGINNER";
  if (n <= 4) return "INTERMEDIATE";
  return "ADVANCED";
}

/** 统一入口：返回原始条目数组 [{ courseName, coach, time, capacity, status }] */
export async function crawl(config, date = new Date()) {
  if (!config) throw new Error("缺少抓取配置");
  if (config.mode === "http") return crawlWithHttp(config, date);
  if (config.mode === "fityun") return crawlWithFityun(config, date);
  if (config.mode === "styd") return crawlWithStyd(config, date);
  if (config.mode === "miliyoga") return crawlWithMiliyoga(config, date);
  if (config.mode === "yizhiniao") return crawlWithYizhiniao(config, date);
  if (config.mode === "haowan") return crawlWithHaowan(config, date);
  if (config.mode === "qingcheng") return crawlWithQingcheng(config, date);
  if (config.mode === "jiahe") return crawlWithJiahe(config, date);
  if (config.mode === "gsteps") return crawlWithGsteps(config, date);
  if (config.mode === "foxdance") return crawlWithFoxdance(config, date);
  if (config.mode === "aiwugong") return crawlWithAiwugong(config, date);
  if (config.mode === "csdsp") return crawlWithCsdsp(config, date);
  if (config.mode === "feiyuntoo") return crawlWithFeiyuntoo(config, date);
  if (config.mode === "mofang") return crawlWithMofang(config, date);
  if (config.mode === "oneMillion") return crawlWithOneMillion(config, date);
  if (config.mode === "avex") return crawlWithAvex(config, date);
  if (config.mode === "justjerk") return crawlWithJustjerk(config, date);
  if (config.mode === "rawgraphy") return crawlWithRawgraphy(config, date);
  if (config.mode === "mock") return mockRaw();
  if (config.mode === "automator") return crawlWithAutomator(config);
  throw new Error(`未知抓取模式: ${config.mode}`);
}
