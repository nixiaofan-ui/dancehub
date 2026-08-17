# DanceHub 课表抓取工作流（crawler）

从舞室自有小程序（如 MAX POWER STUDIO）自动抓取课表并导入 DanceHub 数据库。

## 目录

- `configs.js` — 每套舞室一份抓取配置（AppID、页面路径、CSS 选择器、cron）
- `engine.js` — 抓取引擎：miniprogram-automator 启动开发者工具 → 打开页面 → 抽取卡片
- `mapper.js` — 原始卡片 → `schedules` 表字段映射（课程名/难度/时间/容量/备注）
- `importer.js` — 批量幂等导入（studio/coach 按名复用，schedule 按日期+课程+时间 upsert）
- `index.js` — 编排（日期解析 → 抓取 → 映射 → 导入）+ cron 定时调度
- `routes.js` — 管理接口（配置查看 / 手动触发 / 状态）

## 快速开始

### 1. 前置条件

| 依赖 | 说明 |
|------|------|
| 微信开发者工具 | 需安装并开启「设置 → 安全设置 → 服务端口」 |
| 目标小程序项目 | MAX POWER 小程序源码在本机可被开发者工具打开 |
| miniprogram-automator | 已加入 `server/package.json`，`npm install` 即可 |

### 2. 配置舞室

编辑 `server/src/crawler/configs.js`，按需修改：

```js
{
  id: "maxpower",
  enabled: true,
  label: "MAX POWER STUDIO",
  studio: { name: "MAX POWER STUDIO", city: "上海", region: "CN" },
  appId: "wx_xxxxxxxx",                     // 目标小程序 AppID
  projectPath: "/path/to/maxpower-miniapp", // 目标小程序本地项目目录
  cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
  mode: "automator",                        // automator | mock
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
  dateMode: "today",                        // today | dates
  dates: [],                                // dateMode=dates 时填写，如 ["2026-08-18"]
  pageLoadDelay: 800,
  cron: "0 0 7 * * *",                      // 每天 07:00
}
```

> **选择器以目标小程序真实 DOM 为准**，先用开发者工具的 WXML 面板确认课程卡片结构后再配置。

### 3. 手动触发

需要管理员头 `x-admin-token`（默认 `admin123`）。

```bash
# 抓取 + 导入（单套配置）
curl -X POST http://localhost:3000/api/crawler/run/maxpower \
  -H "x-admin-token: admin123" -H "Content-Type: application/json" -d '{}'

# 干跑：只抓取不写库（联调选择器时使用）
curl -X POST http://localhost:3000/api/crawler/run/maxpower \
  -H "x-admin-token: admin123" -H "Content-Type: application/json" -d '{"dryRun":true}'

# 全部启用配置
curl -X POST http://localhost:3000/api/crawler/run \
  -H "x-admin-token: admin123" -H "Content-Type: application/json" -d '{}'

# 查看配置与最近运行状态
curl http://localhost:3000/api/crawler/configs -H "x-admin-token: admin123"
curl http://localhost:3000/api/crawler/status  -H "x-admin-token: admin123"
```

### 4. 定时调度

`startCrawlScheduler()` 在服务启动时自动注册（见 `server/src/index.js`）。
每套配置按自身 `cron` 字段调度，运行失败只记日志、不影响服务。

### 5. 演示模式（mock）

把某套配置的 `mode` 改为 `"mock"` 即可在无开发者工具环境下联调全链路：
抓取返回演示卡片数据（结构同真实卡片），导入逻辑完全一致。

## 导入语义

- **Studio**：按 `name` 匹配，不存在则创建（`city`+`region` 关联城市，缺省上海/CN）
- **Coach**：按 `studioId + name` 匹配，不存在则创建
- **Schedule**：按 `studioId + scheduleDate + courseName + startTime` 查找，
  命中则更新（课程名/难度/教练/容量/备注/结束时间），否则新建；完成后自动失效首页时间线缓存

## 数据映射规则

| 原始字段 | 目标字段 | 解析 |
|---------|---------|------|
| courseName | courseName | 原样 |
| courseName | difficulty | 关键词：零基础/入门/初级→BEGINNER，中级→INTERMEDIATE，高级/进阶→ADVANCED，否则 ALL_LEVELS |
| time | startTime / endTime | `19:30-20:30`（支持 `~`/`至`/`—` 分隔，24:00 收敛为 23:59） |
| capacity | capacity | `8/20`→20（取总量），`16`→16，缺省 30 |
| status | remark | 原样写入备注（如「预约中」/「约满」） |
| coach | coachId | 按名匹配/创建教练 |