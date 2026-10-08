import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 自动生成的批量配置：iWOD 上海 + 菲体云上海 + 全国 TOP10 城市（两平台混合）
const AUTO_CONFIG_FILES = [
  "studios.auto.json",
  "studios.fityun.json",
  "studios.topcities.json",
  "studios.rawgraphy.json",
  "studios.aiwugong.json",
  "studios.styd.json",
  "studios.foxdance.json",
  "studios.gsteps.json",
  "studios.jiahe.json",
  "studios.csdsp.json",
  "studios.feiyuntoo.json",
  "studios.mofang.json",
  "studios.newdance.json",
  "studios.iwod-extra.json",
  // 2026-09-30 手写接入的四套新平台（都是手机抓包逆向所得，见 engine.js 各引擎注释）
  "studios.miliyoga.json",
  "studios.yizhiniao.json",
  "studios.haowan.json",
  "studios.qingcheng.json",
];

/**
 * 加载批量接入的场馆配置。
 * - studios.auto.json       由 capture/generate_auto_configs.py 生成（iWOD 上海）
 * - studios.fityun.json     由 capture/generate_fityun_configs.py 生成（菲体云上海）
 * - studios.topcities.json  由 capture/generate_topcities_configs.py 生成（全国 TOP10 城市）
 * - studios.rawgraphy.json  由 capture/generate_rawgraphy_configs.py 生成（韩国 rawgraphy 平台）
 * - studios.aiwugong.json   由 capture/scan_aiwugong_brands.mjs 生成（爱舞功/舞十平台）
 * - studios.newdance.json   由 capture/generate_newdance_configs.py 生成（菲云全平台补扫，
 *                            补的是 TOP10 之外的城市：重庆/长沙/苏州/西安/石家庄…）
 * - studios.iwod-extra.json 由 capture/generate_iwod_extra.py 生成（iWOD 全平台补扫，
 *                            补的是 boxes-all.jsonl 里课表样本是舞蹈、但此前没生成配置的 box，
 *                            含 MAX POWER 陆家嘴等一批此前漏掉/丢失的配置）
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
 * - mode: "rawgraphy" 走韩国本土预约平台 rawgraphy.com（로우그래피）。
 *   站点是 Next.js App Router，课表只在 RSC 飞行载荷里（请求头带 RSC: 1 可取）。
 *   整周课表在 timeTable.cells（只有教练名），最近可报名课次在 lessons[]（带 genre/duration）。
 *   ⚠ 平台把首尔时间误标成 Z，解析时按字符串取字段，不能用 new Date()。
 *   接入新场馆：capture/generate_rawgraphy_configs.py --range 1 200 扫描 studioId。
 * - mode: "aiwugong" 走爱舞功 / 舞十平台（wushi.api.aiwugong.cn，Yii2 后端），
 *   继 iWOD、菲体云之后的**第三套**舞蹈 SaaS，深圳 50+ 家在用（CLAP dance studio 等）。
 *   免登录课表接口 POST /Applets/course/index-not-login.html，靠 brand_id 定位品牌；
 *   品牌可枚举（POST /Applets/login/brand.html），见 capture/scan_aiwugong_brands.mjs。
 *   ⚠ 只给 host 不给 brand_id 会 500（SQL 里 ORDER BY FIELD() 参数为空），brand_id 是钥匙。
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
      // 海外场馆没有微信小程序：platform 标 OTHER，
      // 前端「去预约」改为 web-view 打开官网，不走 navigateToMiniProgram
      platform: "OTHER",
      officialUrl: "https://www.1milliondance.com",
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
      platform: "OTHER",
      // 官方预约页：带门店码，用户打开即到本店的试听/预约入口
      officialUrl: "https://apfec.avex.jp/front/trialsearch/?STORE_CODE=1100030712",
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
      platform: "OTHER",
      officialUrl: "https://apfec.avex.jp/front/trialsearch/?STORE_CODE=9999990009",
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

  // ────────────── 海外：韩国 JustJerk（首尔 Hapjeong / Ewha） ──────────────
  {
    id: "justjerk-seoul",
    enabled: true,
    label: "JustJerk Dance Academy (Seoul)",

    studio: {
      name: "JustJerk Dance Academy",
      city: "首尔",
      region: "OVERSEAS",
      platform: "OTHER",
      // 两个校区各自建店（_studioName 覆盖），官网入口用各自课表页，
      // 见 engine.js justjerkEntriesToRaw 的 _officialUrl
      officialUrl: "https://justjerk.co.kr",
    },

    // 官网只有一张课表图片 → 下载 + macOS Vision OCR + 栅格还原（见 engine.js crawlWithJustjerk）
    mode: "justjerk",

    justjerk: {
      // OCR 用的 Python 解释器（需装 pyobjc-framework-Vision；留空则读 JUSTJERK_PYTHON 或 python3）
      python: process.env.JUSTJERK_PYTHON || null,
      branches: [
        {
          key: "hapjeong",
          label: "합정 Hapjeong",
          studioName: "JustJerk · Hapjeong（합정）",
          url: "https://justjerk.co.kr/hapjeongschedule",
          weekdays: 6, // MON~SAT
        },
        {
          key: "ewha",
          label: "이화 Ewha",
          studioName: "JustJerk · Ewha（이화）",
          url: "https://justjerk.co.kr/ewhaschedule",
          weekdays: 7, // MON~SUN（周日场次自带 3PM/430PM 时间）
        },
      ],
    },

    // 课表按「月」发布，每天核对一次足够
    dateMode: "nextDays",
    days: 45,
    dates: [],
    refreshHours: 24,
    cron: null,
    timeFormat: "HH:mm-HH:mm",
  },

  // ────────────── 海外：韩国 PREPIX（江南）· 暂不可接 ──────────────
  // 官网 prepixstudio.com 已停服（现在返回裸 IIS 默认页），
  // prepix.co.kr / prepixstudio.co.kr / www.prepix.kr 等备用域名均无法解析（DNS 失败）。
  // 平台上也没有它的条目（generate_rawgraphy_configs.py 扫描 1~120 未命中）。
  // 目前只剩 Instagram，而 IG 官方 API 读不到任意公开账号（Basic Display 已于 2024-12-04 关闭）。
  // → 保持停用，等官网恢复或谈成官方合作后再接。启用前必须先补 rawgraphy.studioId 或换 mode。
  {
    id: "prepix-seoul",
    enabled: false,
    label: "PREPIX Movement (Seoul)",

    studio: {
      name: "PREPIX Movement",
      city: "首尔",
      region: "OVERSEAS",
      platform: "OTHER",
      officialUrl: null, // 官网已停服，暂无可用入口
    },

    mode: "rawgraphy",
    rawgraphy: { studioId: null },

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
    if (c.mode === "styd" && c.styd?.brandCode) return `brand:${c.styd.brandCode}`;
    // 魔方约课：一个 tenantId = 一个品牌（旗下多门店共用），与菲体云 orgId 同级
    if (c.mode === "mofang") return `mofang:${c.mofang?.tenantId || c.mofang?.appId || c.id}`;
    if (c.mode === "foxdance") return `fox:${c.id}`;
    if (c.mode === "gsteps") return `gsteps:${c.id}`;
    if (c.mode === "jiahe") return `jiahe:${c.id}`;
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
