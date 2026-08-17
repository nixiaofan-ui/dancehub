/**
 * 舞室课表抓取配置
 * 每套配置对应一个舞室，包含：目标小程序信息、页面路径、CSS 选择器、
 * 时间解析格式与定时表达式。
 *
 * 关键说明：
 * - mode: "automator" 走微信开发者工具自动化（miniprogram-automator），
 *   需要本机安装微信开发者工具并开启服务端口，且 target 小程序项目在本地可打开。
 * - mode: "mock" 走演示数据，不依赖任何外部工具，便于无环境时联调整条链路。
 */
export const crawlerConfigs = [
  {
    id: "maxpower",
    enabled: true,
    label: "MAX POWER STUDIO",

    // 目标舞室（导入时按 name 匹配，不存在则创建）
    studio: {
      name: "MAX POWER STUDIO",
      city: "上海",
      region: "CN",
    },

    // —— 目标小程序（miniprogram-automator 专用）——
    appId: "wx_XXXXXXXXXXXXXXXX", // TODO: 替换为 MAX POWER 小程序真实 AppID（仅作记录/校验）
    projectPath: "/Users/nnnnnnxf/Desktop/dancehub/wechat_mcp_server", // TODO: 替换为 MAX POWER 小程序本地项目目录
    cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli", // 微信开发者工具 CLI
    automatorPort: 9420, // 开发者工具自动化端口

    // 抓取模式：automator | mock
    mode: "mock",

    // 页面路径
    entryPath: "pages/index/index",
    schedulePagePath: "pages/class/list",

    // CSS 选择器（基于 MAX POWER 课程卡片 DOM 结构，见截图：课程名/时间/教练/状态/容量）
    selectors: {
      list: ".class-list .class-card",
      courseName: ".course-name",
      coach: ".coach",
      time: ".time",
      capacity: ".capacity",
      status: ".status",
    },

    // 时间解析格式（与页面文案一致）
    timeFormat: "HH:mm-HH:mm",

    // 抓取日期：today = 当天；dates = 指定日期数组（YYYY-MM-DD）
    dateMode: "today",
    dates: [],

    // 页面加载等待（ms）
    pageLoadDelay: 800,

    // 定时表达式（node-cron）：每天 07:00 抓取一次
    cron: "0 0 7 * * *",
  },
];

export function getCrawlerConfig(id) {
  return crawlerConfigs.find((c) => c.id === id);
}

export function listCrawlerConfigs() {
  return crawlerConfigs;
}
