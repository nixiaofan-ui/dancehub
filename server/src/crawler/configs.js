import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 自动生成的批量配置：iWOD 上海 + 菲体云上海 + 全国 TOP10 城市（两平台混合）
const AUTO_CONFIG_FILES = [
  "studios.auto.json",
  "studios.fityun.json",
  "studios.topcities.json",
];

/**
 * 加载批量接入的场馆配置。
 * - studios.auto.json       由 capture/generate_auto_configs.py 生成（iWOD 上海）
 * - studios.fityun.json     由 capture/generate_fityun_configs.py 生成（菲体云上海）
 * - studios.topcities.json  由 capture/generate_topcities_configs.py 生成（全国 TOP10 城市）
 * 文件不存在或格式错误时静默跳过，不影响手写配置。
 */
function loadAutoConfigs() {
  const out = [];
  for (const file of AUTO_CONFIG_FILES) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, file), "utf8"));
      if (Array.isArray(raw)) out.push(...raw);
    } catch {
      /* 缺失即跳过 */
    }
  }
  return out;
}

/**
 * 舞室课表抓取配置
 * 每套配置对应一个舞室，包含：目标小程序信息、页面路径、CSS 选择器、
 * 时间解析格式与调度参数。
 *
 * 关键说明：
 * - mode: "http" 走 iWOD SaaS 公开课表 API（免登录，签名算法已逆向复现，
 *   见 engine.js iwodSignature）。适用于所有使用 iWOD（杭州思劢科技）约课系统的舞室。
 *
 *   ⚠ 关键：iWOD 是「一个舞室（或一个连锁集团）一个小程序」，各家 appId 不同，
 *   且平台没有任何公开的场馆目录（搜索附近门店接口 /box/searchNearbyBox 需登录态）。
 *   因此接入新舞室时必须先拿到它的 appId，两种取法：
 *     a) Mac 微信打开该舞室小程序 → 运行 capture/scan_appids.py --from-cache 自动识别；
 *     b) 手机抓包 → 运行 capture/parse_iwod_flows.py 从 Referer/参数里读出 appId。
 *   拿到 appId 后用 capture/probe_studio.py <boxId> <appId> 验证并拉取全连锁门店。
 *
 *   同一集团的多家分店共用一个 appId，isAllBoxClasses=1 会一次带出全部门店课表。
 * - mode: "automator" 走微信开发者工具自动化（miniprogram-automator），
 *   需要本机安装微信开发者工具并开启服务端口，且 target 小程序项目在本地可打开。
 * - mode: "mock" 走演示数据，不依赖任何外部工具，便于无环境时联调整条链路。
 *
 * dateMode:
 * - "today"     只抓当天
 * - "dates"     抓 config.dates 指定的日期数组（YYYY-MM-DD）
 * - "nextDays"  抓今天起 config.days 天（默认 7），适合每次全量刷新未来课表
 *
 * 调度：
 * - refreshHours  距上次「成功抓取」超过该小时数，心跳自动补跑（默认 6，抗休眠/关机）
 * - cron          可选的额外固定时刻触发，六段式；null 表示只用自愈心跳
 */
/** 手写配置（长期维护的核心品牌，可覆盖自动配置的字段） */
const manualConfigs = [
  {
    id: "maxpower",
    enabled: true,
    label: "MAX POWER STUDIO",

    // 品牌默认信息（分店 studio 会继承 city/region，name 用各门店 boxName）
    studio: {
      name: "MAX POWER STUDIO",
      city: "上海",
      region: "CN",
    },

    // 抓取模式：http | automator | mock
    mode: "http",

    // —— iWOD HTTP 抓取配置 ——
    http: {
      baseUrl: "https://api2.iwod.cn",
      appId: "wxa46dc234113caadd", // MAX POWER 自家小程序 appId（每家舞室各不相同）
      boxId: 14810, // MAX POWER STUDIO（陆家嘴店）；isAllBoxClasses=1 会带出全部门店
    },

    // 抓取日期：nextDays = 今天起 N 天（每日 07:00 全量刷新未来一周课表）
    dateMode: "nextDays",
    days: 7,
    dates: [],

    // 刷新间隔（小时）：距上次「成功抓取」超过该时长，心跳即自动补跑一次。
    // 不绑定具体时刻，因此电脑休眠/关机期间错过也不会丢数据（醒来后自动补齐）。
    refreshHours: 6,

    // 可选的额外固定时刻触发（node-cron 六段式：秒 分 时 日 月 周）。
    // 例：想额外在每天 07:00 抓一次 → "0 0 7 * * *"。设为 null 表示只用自愈心跳。
    cron: null,

    // —— 以下为旧 automator 模式保留字段（http 模式不使用）——
    projectPath: "",
    cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
    automatorPort: 9420,
    entryPath: "pages/index/index",
    schedulePagePath: "pages/class/list",
    selectors: {
      list: ".class-list .class-card",
      courseName: ".course-name",
      coach: ".coach",
      time: ".time",
      capacity: ".capacity",
      status: ".status",
    },
    timeFormat: "HH:mm-HH:mm",
    pageLoadDelay: 800,
  },

  {
    id: "fityun-phoenix",
    enabled: true,
    label: "Phoenix 火凤凰舞蹈俱乐部",

    // 品牌默认信息（各分店 studio 继承 city/region，name 用 branches[].name）
    studio: {
      name: "Phoenix 火凤凰",
      city: "上海",
      region: "CN",
    },

    // 抓取模式：fityun = 菲体云 SaaS 公开课表 API（免登录）
    mode: "fityun",

    // —— 菲体云 HTTP 抓取配置 ——
    // 机构/门店分别由请求头 orgid / branchid 标识；branchid 不传会落回主店，
    // 因此多门店必须逐店列出（门店 ID 取自 GET /org/orglist 的 info.org_info[].id）。
    fityun: {
      baseUrl: "https://xiaochengxu-edu-api-hz.fityun.cn",
      orgId: "11054206",
      branches: [
        { id: "1560", name: "Phoenix·中山公园店（长宁）" },
        { id: "1796", name: "Phoenix·长寿路店（普陀）" },
        { id: "0", name: "Phoenix·新天地店（黄浦）" },
        { id: "1701", name: "Phoenix·世纪大道店（浦东）" },
      ],
    },

    dateMode: "nextDays",
    days: 7,
    dates: [],
    refreshHours: 6,
    cron: null,
    timeFormat: "HH:mm-HH:mm",
  },

  {
    id: "fityun-lohas",
    enabled: true,
    label: "Lohas Dance（乐活舞蹈）",

    studio: {
      name: "Lohas Dance",
      city: "上海",
      region: "CN",
    },

    mode: "fityun",

    // —— 菲体云 HTTP 抓取配置（同 fityun-phoenix）——
    fityun: {
      baseUrl: "https://xiaochengxu-edu-api-hz.fityun.cn",
      orgId: "11044551",
      branches: [
        { id: "0", name: "Lohas Dance·上影店（长宁）" },
        { id: "1117", name: "Lohas Dance·日月光店（黄浦）" },
        { id: "1657", name: "Lohas Dance·普陀店（普陀）" },
        { id: "1697", name: "Lohas Dance·杨浦RE店（杨浦）" },
        { id: "1476", name: "MCLOCK·STAR.LINE店（黄浦）" },
      ],
    },

    dateMode: "nextDays",
    days: 7,
    dates: [],
    refreshHours: 6,
    cron: null,
    timeFormat: "HH:mm-HH:mm",
  },

  {
    id: "fityun-gh5",
    enabled: true,
    label: "GH5 舞蹈工作室",

    studio: {
      name: "GH5",
      city: "上海",
      region: "CN",
    },

    mode: "fityun",

    fityun: {
      baseUrl: "https://xiaochengxu-edu-api-hz.fityun.cn",
      orgId: "11005244",
      branches: [{ id: "0", name: "GH5·中山公园店（长宁）" }],
    },

    dateMode: "nextDays",
    days: 7,
    dates: [],
    refreshHours: 6,
    cron: null,
    timeFormat: "HH:mm-HH:mm",
  },

  {
    id: "fityun-rbdance",
    enabled: true,
    label: "RB Dance Studio",

    studio: {
      name: "RB Dance Studio",
      city: "上海",
      region: "CN",
    },

    mode: "fityun",

    fityun: {
      baseUrl: "https://xiaochengxu-edu-api-hz.fityun.cn",
      orgId: "11057351",
      branches: [{ id: "0", name: "RB Dance Studio（普陀）" }],
    },

    dateMode: "nextDays",
    days: 7,
    dates: [],
    refreshHours: 6,
    cron: null,
    timeFormat: "HH:mm-HH:mm",
  },

  // ────────────── 海外：韩国 1MILLION ──────────────
  {
    id: "one-million-seoul",
    enabled: true,
    label: "1MILLION Dance Studio (Seoul)",

    studio: {
      name: "1MILLION Dance Studio",
      city: "首尔",
      region: "OVERSEAS",
    },

    mode: "oneMillion",

    dateMode: "nextDays",
    days: 30,
    dates: [],
    refreshHours: 24,
    cron: null,
    timeFormat: "HH:mm-HH:mm",
  },

  // ────────────── 海外：日本 MAJOR EAST（原宿/目黑） ──────────────
  {
    id: "major-east-tokyo",
    enabled: true,
    label: "MAJOR Dance Studio EAST (Tokyo)",

    studio: {
      name: "MAJOR Dance Studio EAST",
      city: "东京",
      region: "OVERSEAS",
    },

    mode: "avex",

    avex: {
      storeCode: "1100030712",
    },

    dateMode: "nextDays",
    days: 14,
    dates: [],
    refreshHours: 24,
    cron: null,
    timeFormat: "HH:mm-HH:mm",
  },

  // ────────────── 海外：日本 MAJOR WEST（心斋桥/梅田） ──────────────
  {
    id: "major-west-osaka",
    enabled: true,
    label: "MAJOR Dance Studio WEST (Osaka)",

    studio: {
      name: "MAJOR Dance Studio WEST",
      city: "大阪",
      region: "OVERSEAS",
    },

    mode: "avex",

    avex: {
      storeCode: "9999990009",
    },

    dateMode: "nextDays",
    days: 14,
    dates: [],
    refreshHours: 24,
    cron: null,
    timeFormat: "HH:mm-HH:mm",
  },
];

/**
 * 生效配置 = 手写配置 + 自动生成的批量配置。
 *
 * 合并规则：
 * - id 冲突时手写配置优先（便于单独调参 / 临时停用自动接入的某家）；
 * - 同一目标重复时同样手写优先，其次是先出现的自动配置：
 *     iWOD   → boxId 相同即同一门店
 *     菲体云 → orgId 相同即同一机构
 */
function mergeConfigs(manual, auto) {
  const out = [];
  const seenId = new Set();
  const seenTarget = new Set();

  // 去重键：一套配置只对应一个抓取目标（门店 or 机构）
  const targetKey = (c) => {
    if (c.mode === "http" && c.http?.boxId != null) return `box:${c.http.boxId}`;
    if (c.mode === "fityun" && c.fityun?.orgId) return `org:${c.fityun.orgId}`;
    return null;
  };

  const push = (c, isAuto) => {
    if (!c || !c.id || seenId.has(c.id)) return;
    const key = targetKey(c);
    if (isAuto && key && seenTarget.has(key)) return;
    seenId.add(c.id);
    if (key) seenTarget.add(key);
    out.push(c);
  };

  for (const c of manual) push(c, false);
  for (const c of auto) push(c, true);
  return out;
}

export const crawlerConfigs = mergeConfigs(manualConfigs, loadAutoConfigs());

export function getCrawlerConfig(id) {
  return crawlerConfigs.find((c) => c.id === id);
}

export function listCrawlerConfigs() {
  return crawlerConfigs;
}
