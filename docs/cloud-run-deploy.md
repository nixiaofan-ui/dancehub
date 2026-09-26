# DanceHub 微信云托管部署手册（2026-09-22 已跑通）

> 现状：正式小程序 `wx9ba1b1932b7a411b` + 云托管环境 `prod-d8g7j87ar768b52e7`（上海）+ 服务 `dancehub-server`（容器端口 **3000**）
> 访问方式：小程序 `wx.cloud.callContainer`（微信私有协议，**无需域名、无需备案、未开外网访问**）

---

## 一、日常发版（最常用）

```bash
# 1) 把改动同步到干净代码目录（不含 node_modules/.env）
cd /Users/nnnnnnxf/Desktop/dancehub/server
rm -f ../dancehub-server-deploy.zip
zip -rq ../dancehub-server-deploy.zip . -x "node_modules/*" ".env" "backups/*" "*.log" ".crawl-state.json"
rm -rf /tmp/dh-deploy && mkdir -p /tmp/dh-deploy && cd /tmp/dh-deploy && unzip -q /Users/nnnnnnxf/Desktop/dancehub/dancehub-server-deploy.zip

# 2) 发布（参数必须给全，否则 CLI 弹交互菜单卡住）
export PATH="/Users/nnnnnnxf/.workbuddy/binaries/node/versions/22.22.2-3/bin:$PATH"
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
wxcloud run:deploy /tmp/dh-deploy \
  --envId prod-d8g7j87ar768b52e7 \
  --serviceName dancehub-server \
  --targetDir . --dockerfile Dockerfile --containerPort 3000 \
  --envParams "DATABASE_URL=mysql://root:<密码>@10.28.107.10:3306/dancehub&NODE_ENV=production&PORT=3000&WECHAT_APPID=wx9ba1b1932b7a411b&WECHAT_SECRET=<secret>" \
  --remark "说明" --noConfirm
```

- 首次登录：`wxcloud login --appId wx9ba1b1932b7a411b --privateKey <控制台→设置→CLI密钥>`（密钥新建后约 1 分钟生效；登录态存 `~/.wxcloudconfig`）
- 构建约 2 分钟，成功表现为版本状态 `normal` 且流量 100%

## 二、查状态 / 拉日志

```bash
# 版本列表（Status: normal / build_failed / deploy_failed）
wxcloud version:list --envId prod-d8g7j87ar768b52e7 --serviceName dancehub-server --json

# 构建日志 / 容器启动日志（CLI 自带日志流会报 TopicNotExist，用脚本绕）
node /tmp/fetch-buildlog.js     # DescribeCloudBaseRunBuildLog
node /tmp/fetch-runlog.js       # DescribeCloudBaseRunProcessLog（容器 stdout，含 EACCES 之类的启动报错）
```

## 三、数据库

- 云 MySQL = **CynosDB 5.7.18**，内网 `10.28.107.10:3306`、公网 `sh-cynosdbmysql-grp-io5jnrh6.sql.tencentcdb.com:27888`
- 字符集：库级 `utf8mb4_unicode_ci`（服务器默认 utf8，建库时要显式指定）
- 迁移数据：
  ```bash
  docker exec dancehub-mysql mysqldump -uroot -proot123 --default-character-set=utf8mb4 \
    --skip-lock-tables --single-transaction --routines --triggers --hex-blob --column-statistics=0 \
    dancehub > /Users/nnnnnnxf/Desktop/dancehub/backups/dancehub-cloud-final.sql

  docker exec -i dancehub-mysql mysql -h sh-cynosdbmysql-grp-io5jnrh6.sql.tencentcdb.com -P 27888 \
    -u root -p'<密码>' --default-character-set=utf8mb4 dancehub \
    < /Users/nnnnnnxf/Desktop/dancehub/backups/dancehub-cloud-final.sql
  ```
- 表名是 Prisma 模型名：`Studio / Schedule / Coach / City / User / Follow / Booking / Reminder`

## 四、小程序端切换

`miniapp/utils/config.js`：

```js
USE_CLOUD: true,                                   // false → 走局域网 API_BASE
CLOUD_RUNNER_ID: "prod-d8g7j87ar768b52e7",         // 云托管环境 ID（不是云开发环境 ID）
CLOUD_SERVICE_NAME: "dancehub-server",             // 必须与云托管服务名完全一致
```

改完在开发者工具 **清缓存 → 全部清除** + **⌘B**（`app.js` 里 `wx.cloud.init` 才会跑）。

## 五、排错速查（都踩过）

| 现象 | 原因 / 解法 |
|---|---|
| 云端报 `zipfile is empty` | `.dockerignore` 里有 `!` 取反规则 → CLI 用 archiver 打包会打出空包，删掉取反行 |
| 容器 `Back-off restarting failed container` + `listen EACCES ... :80` | 容器非 root，云上不能绑 <1024 端口 → 用 3000 |
| CLI 卡在「请选择部署方式」 | 缺 `--targetDir`（或 `--libraryImage`）→ 参数给全 |
| CLI 报登录失败但密钥是对的 | 沙箱代理掐断 node 请求（`socket hang up`）→ `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy` |
| 推镜像 `broken pipe` | 云端网络抖动，重跑一次即可 |
| Prisma `could not locate the Query Engine for runtime "linux-musl-openssl-3.0.x"` | schema.prisma 的 `binaryTargets` 加上它；Alpine 还要 `apk add openssl` |
| 课表时间差 8 小时 | 镜像里 `ENV TZ=Asia/Shanghai` 没生效 |
| 小程序报 `cloud function not found` | `USE_CLOUD`/`CLOUD_RUNNER_ID`/`CLOUD_SERVICE_NAME` 三个字段任一不对 |

## 六、定时任务（2026-09-22 v7 起：内置调度器 + 实例常驻）

> ⚠ 踩坑记录：云托管**没有**控制台级「定时触发器」（那是云函数的功能），服务设置里只有「定时扩缩容」。
> v6 曾按外部触发器模式部署（CRAWL_MODE=trigger），实测无驱动方，v7 起改回内置调度器。

- 云端**不设** `CRAWL_MODE`（默认 scheduler）：进程内 5 分钟心跳自愈抓取 + 每分钟提醒扫描，与本地 Mac 行为一致
- **前提：实例必须常驻 ≥ 1**，否则缩容到 0 后没有任何进程在跑定时任务。控制台 → 服务设置 → 「定时扩缩容」→ 开启 → 加一条全天规则（周一~周日 00:00–23:59，最小实例 1）
- 抓取状态存 MySQL `CrawlState` 表（容器文件系统易失，不能再用 .crawl-state.json）
- 备用触发端点（无需鉴权，服务未开外网；自带防重入），可用于手动/外部驱动：
  - `POST /api/crawler/tick` —— 立即 202 返回，后台补抓「到期」配置（refreshHours 6h）
  - `POST /api/reminders/tick` —— 同步扫描到期提醒并推送订阅消息（≤50 条/轮）
- 云端 CrawlState 为空 = 全部视为到期，首启会全量补抓 503 个配置（一次性）
- 验证：`docker exec dancehub-mysql mysql -h sh-cynosdbmysql-grp-io5jnrh6.sql.tencentcdb.com -P 27888 -u root -p123dhBIGBANG dancehub -e "SELECT COUNT(*),MAX(lastSuccessAt) FROM CrawlState;"`

## 七、分工约定

- **抓取已上云**（v7 起内置调度器 + 实例常驻 ≥1），本地 Mac 只是开发环境，可随时关机
- 云 MySQL 公网地址平时**保持关闭**，只在迁移数据时临时开启
