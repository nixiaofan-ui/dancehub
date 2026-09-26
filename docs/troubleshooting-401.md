# 「登录失效，请重启小程序」排查手册（401）

> 现象：小程序弹「登录失效，请重启小程序」，关闭重进后依旧没有数据。
> 结论先行：**这不是登录态的问题，重启没用。** 弹这句 toast 的唯一条件是某个请求返回了 HTTP 401。

## 零、2026-09-26 实测定位

诊断输出 `HEALTH: 200` / `LOGIN: 500`，把范围一下缩到最小：

- **网关和容器都是好的**（200 说明请求进到了容器、数据库也连上了），不是云托管没放行。
- 真正的故障链：`/auth/login` 500 → 拿不到 token → 后续业务接口带**空 token** 打过去 → `requireAuth` 返回 401 → 弹「登录失效，请重启小程序」。
  **所以 toast 说的"登录失效"是结果，不是原因；重启当然治不好。**
- 微信凭据本身**有效**（用云上的 appid/secret 换 access_token 成功），排除了 secret 错误。

500 是被 `errorHandler` 压过的「服务器内部错误」，真实原因有两种可能，已在 011 版本里分开回传：

| 回传文案 | 含义 | 怎么办 |
|---|---|---|
| `微信登录失败: 40029 ...` | 微信认为这个 code 无效 | 开发者工具**右上角头像重新扫码登录**（IDE 登录态失效时模拟器给的 code 换不到 openid） |
| `微信接口不可达（容器可能无公网出口...）` | 容器连不上 api.weixin.qq.com | ✅ 已确认就是这条，见第六节；012 起改用网关注入的 `x-wx-openid` |

## 一、这句话是谁弹的

`miniapp/utils/request.js` 里只要 `statusCode === 401` 就弹 toast。而服务端只有两处会返回 401：

| 来源 | 位置 | 触发条件 |
|---|---|---|
| 业务接口 token 校验失败 | `server/src/middleware/auth.js` | `Authorization: Bearer <token>` 缺失或签名校验不过 |
| 登录接口本身失败 | `server/src/routes/auth.routes.js` | `code2session` 没拿到 openid |

**关键点：`/auth/login` 这个请求是不带 token 的。** 如果它都返回 401，说明请求压根没进到容器，
是网关把它拦在了外面 —— 这时重启小程序一百次也不会有变化。

## 二、改过之后（2026-09-26）

- 401 单独成类，控制台打印**原始响应体**：网关 401（通常是空 body 或微信网关自己的错误串）
  和业务 401（`{code:401,message:"登录已过期，请重新登录"}`）一眼可分。
- **业务接口 401 → 静默重新 `wx.login` 并重试一次**，不再要求用户手动重启。并发请求共用一个重登任务，不会把 `wx.login` 打爆。
- **登录接口自己 401 → 弹「云服务未放行（401）」**，并在控制台打印排查顺序。
- `app.js` 记录 `globalData.initError`（不 throw —— `app.ready` 变成 rejected 会让所有页面首屏空白）。

## 三、一键诊断（开发者工具 Console 粘贴执行）

```js
(function () {
  const ENV = "prod-d8g7j87ar768b52e7", SVC = "dancehub-server";
  try { wx.cloud.init({ env: ENV, traceUser: false }); } catch (e) { console.log("cloud.init 失败:", e); }
  const call = (m, p, d) => new Promise((r) => {
    wx.cloud.callContainer({
      config: { env: ENV }, path: p, method: m, data: d,
      header: { "content-type": "application/json", "X-WX-SERVICE": SVC },
      success: (res) => r({ status: res.statusCode, data: res.data }),
      fail: (e) => r({ fail: e.errMsg || e }),
    });
  });
  (async () => {
    console.log("1) 容器出口:", await call("GET", "/api/diag/net"));
    console.log("2) HEALTH:", await call("GET", "/api/health"));
    const lr = await new Promise((r) => wx.login({ success: r, fail: (e) => r({ code: null, err: e }) }));
    console.log("3) wx.login:", lr.code ? "已拿到 code" : "失败 " + JSON.stringify(lr.err));
    console.log("4) LOGIN:", await call("POST", "/api/auth/login", { code: lr.code, devId: "diag" }));
  })();
})();
```

结果读法：

- `容器出口` = `reachable(...)` → 容器能连微信，问题在 code 本身（看回传的 errcode）；= `unreachable` → 容器没有公网出口，改用 `x-wx-openid` 方案。
- `HEALTH` 401 → 网关层没放行（服务/环境/欠费），见第四节。
- `HEALTH` 200 + `LOGIN` 500 → 本次的情况，看 LOGIN 回传的 message 文案（011 起会带具体原因）。
- 全通 → token 链路正常，问题在页面层。

## 四、云端排查顺序（按命中率排序）

1. **最小实例数是 0** → 服务缩容到 0 后，新请求要等冷启动，网关会直接拒。
   控制台 → 云托管 → 服务 `dancehub-server` → 服务设置 → 实例数量 / 定时扩缩容 → **最小实例数改成 1**。
   （部署手册第六节要求常驻 ≥1，否则定时抓取也没进程在跑。）
2. **版本与流量**：`wxcloud version:list --envId prod-d8g7j87ar768b52e7 --serviceName dancehub-server --json`
   必须有 `Status: normal` 且 `flow=100` 的版本。
3. **欠费/停服**：环境页若提示欠费，网关会对所有请求返回 401。
4. **环境 ID 与小程序不匹配**：`CLOUD_RUNNER_ID` 必须是云托管环境 ID（不是云开发环境 ID），且环境与小程序同主体。

## 五、本地兜底（云托管排不掉时先恢复开发）

```bash
# 1) 起本地服务端（MySQL/Redis 走 docker-compose）
cd /Users/nnnnnnxf/Desktop/dancehub/server && npm run dev

# 2) 小程序切回直连
#    miniapp/utils/config.js  →  USE_CLOUD: false
#    开发者工具「详情 → 本地设置」勾选「不校验合法域名」，然后清缓存 + 编译（⌘B）
```

⚠ 该模式只在开发者工具和真机调试下可用，**体验版/正式版必须回到云托管**。

## 六、定案：云托管容器没有公网出口（2026-09-26）

实测：`/api/diag/net` → `{"wechatApi":"unreachable: fetch failed","ms":5}`；登录回传
`微信接口不可达（容器可能无公网出口或超时）: fetch failed`。
5ms 就失败，说明不是超时，是**出网被掐断**（或 DNS 直接失败）。

### 修法：登录改用网关注入的 openid（012 已上线）

云托管网关在每个 `callContainer` 请求里注入 `x-wx-openid`，走微信私有协议，
服务 `IsPublic=false`（只允许小程序经网关进来），客户端伪造不了。

`auth.routes.js` 现在这样取值：

```
x-wx-openid（云上，首选） → 拿不到则回退 code2session（本地/局域网开发）
```

登录响应里多了 `via` 字段：`gateway` = 走的网关 openid，`code2session` = 走微信接口。

### 连带影响（都要出公网，云上同样跑不了）

- **订阅消息推送**（开课提醒）：`subscribeMessage.send` 也要访问 api.weixin.qq.com → 云上会失败。
- **YouTube 课程视频预览**：同样依赖外网。
- 爬虫已用 `SKIP_CRAWLER=1` 在云上关闭，本来就不跑。

这几项要么在控制台给容器开出网，要么改走微信「云调用」通道。

### 验证

开发者工具 ⌘B 重新编译后跑第三节脚本，期望输出：

```
出口: 200 {"wxHeaders":{"x-wx-openid":"oXXXX***XXXX(28)"}, ...}
登录: 200 {"code":0,"data":{"token":"...","via":"gateway"},...}
```

若 `wxHeaders` 里没有 `x-wx-openid`，说明该服务没开启注入 —— 去控制台
服务 → 安全配置 打开「微信鉴权/调用鉴权」，或者给容器开出网。

## 七、订阅消息改走云调用（2026-09-26）

容器没有公网出口，所以 `subscribeMessage.send` 不能再用
`https://api.weixin.qq.com/...?access_token=...`。改走云调用：
**容器内直接请求 `http://api.weixin.qq.com`（是 http），网关自动注入鉴权，不用 access_token。**

代码见 `server/src/services/wechat.service.js`：云调用优先，鉴权类 errcode 时回退 access_token（供本地开发）。

### 控制台要做的两件事（缺一个都拿不到权限）

入口是**浏览器**上的独立站点，不是开发者工具：

```
https://cloud.weixin.qq.com/cloudrun/service/dancehub-server
```

1. 左侧栏 → **云调用** → 打开 **「开放接口服务」** 开关
2. 同一页 → **「微信令牌权限」→ 配置接口** → 加入一行：

```
/cgi-bin/message/subscribe/send
```

（只填 `api.weixin.qq.com` 之后、`?` 之前的部分）

⚠️ 该列表默认是空的（显示「暂无 API 接口」），**不配置的接口无法使用云调用**。
改完权限后**需要重建版本才会生效** —— 重新部署一次即可。

### 自检（不用等真实推送）

```js
wx.cloud.callContainer({
  config: { env: "prod-d8g7j87ar768b52e7" },
  path: "/api/diag/cloudcall", method: "GET",
  header: { "X-WX-SERVICE": "dancehub-server" },
  success: (r) => console.log(JSON.stringify(r.data)),
});
```

读法：

| 返回 | 含义 |
|---|---|
| `errcode 40003 / 40037 / 47003` | ✅ 鉴权已通过，云调用生效（报的是参数错，正是预期） |
| `errcode 40001 / 48001 / 40164` | ❌ 通道未生效：接口路径没配，或配完没重建版本 |
| `verdict: 云调用不可达` | ❌ 容器内 http 到 api.weixin.qq.com 都失败 |

**2026-09-26 实测（版本 016，19:23）**：配置接口路径 + 重建版本后返回

```json
{"target":"http://api.weixin.qq.com/cgi-bin/message/subscribe/send",
 "errcode":40003,"errmsg":"invalid openid ...","ms":398,
 "templateConfigured":false,
 "verdict":"云调用已生效（鉴权通过，返回的是参数类错误，属预期）"}
```

`40003 invalid openid` 是自检**故意**传 `"oINVALID"` 造成的 —— 能拿到这个错误码就说明
请求已经穿过网关鉴权抵达微信，通道彻底通了。`templateConfigured: false` 是环境变量
`WX_CLASS_REMINDER_TMPL` 还没配，见下节。

### 还差的最后一块：模板 ID

推送真正跑起来还需要**订阅消息模板**，它跟云调用是两件事：

1. 小程序后台 mp.weixin.qq.com → 功能 → 订阅消息 → 选用模板 → 抄下模板 ID
2. 云托管 → 服务 `dancehub-server` → 服务设置 → 环境变量，加一条：

```
WX_CLASS_REMINDER_TMPL=<模板ID>
```

⚠️ 控制台那个输入框同样可能置灰改不动（和最小实例数一样）。用 CLI 直接注入即可，
它会先读旧配置合并，不会丢字段，**且不需要重新构建镜像**：

```bash
wxcloud service:config update -e prod-d8g7j87ar768b52e7 -s dancehub-server \
  -p "DATABASE_URL=...&NODE_ENV=...&PORT=3000&WECHAT_APPID=...&WECHAT_SECRET=...&JWT_SECRET=...&SKIP_CRAWLER=1&WX_CLASS_REMINDER_TMPL=<模板ID>"
```

（`-p` 是**整体覆盖**，所以必须带上现有的全部 7 项再追加新的）

没配这个变量时 `subscribeTplId` 为 null，提醒会退化成 LOCAL 类型，压根不会发。
小程序端（`utils/subscribe.js`）已经会拿 `/config/subscribe` 里的 `classReminderTplId`
去调 `wx.requestSubscribeMessage`，无需改动。

### 🟡 换模板必须同步改三个地方（错一个就是 47003）

`buildClassReminderData`（`server/src/services/reminder.service.js`）的**键名必须和后台
「我的模板 → 模板详情」里的字段编号一字不差**：

| 后台字段 | 含义 | 当前代码 |
|---|---|---|
| `name1` | 课程名称 | `r.schedule.courseName` |
| `time2` | 课程时间 | 日期 + `startTime` |
| `thing3` | 上课地点 | `r.schedule.studio.name` |
| `thing8` | 授课老师 | `r.schedule.coach.name`（缺失回退「待定」） |

另外两个容易踩的：

1. **长度按「字符数」不是按「字数」**：一个汉字算 2，上限 20。`slice(0, 20)`
   会把 20 个汉字算成 40 → 微信拒（47003）。`fitText()` 用码点 `>= 0x1100` 计 2
   （覆盖中日韩与全角；只按汉字区间写正则会漏韩文，舞室名很常见）。
2. **`time` 类型要中文格式**：`"2026-09-27 19:00"` 有被拒风险，用 `"2026年9月27日 19:00"`。

`/api/diag/cloudcall` 现在会**复用真实的 `buildClassReminderData`** 发一次自检，
所以通道、模板 ID、字段编号三项一次全验：

- `40003 invalid openid` → ✅ 三项都对（openid 是故意传错的）
- `40037` → 模板 ID 不被微信认可
- `47003` → 字段编号或值格式不匹配
- `40001/48001/40164` → 云调用通道没生效

### 本地没配模板时别让用户空授权

`/config/subscribe` 的 `subscribeConfigured` 现在要求
`appId && appSecret && classReminderTplId` 三者齐备 —— 缺模板时小程序端不该弹授权框，
否则用户点了「允许」也收不到任何消息（一次性授权还被白白消耗掉）。

### ⚠️ 一次性订阅的额度是共享的，自检会吃掉真实提醒那一条

**每授权一次 = 一条推送额度**，且额度挂在「用户 + 模板」上，不区分是谁发的。
所以 `/api/diag/cloudcall?real=1` 和真正的开课提醒**抢的是同一份额度**：

- 授权后先跑自检 → 自检消耗掉这一条 → 到点的真提醒会报 `43101` 发不出去
- 想两全：自检确认 `errcode: 0` 收到测试消息后，**把提醒关掉再点开一次**（重新授权，
  补回一条额度，同时把记录从 LOCAL 刷新成 SUBSCRIBE）

判断是否还有额度不要靠猜，直接查云库里那条提醒记录：

```
type=SUBSCRIBE + subscribeTplId 非空  → 到点会真发
type=LOCAL     + subscribeTplId=null → 根本不会发（多半是授权没发生）
```

授权是否真的发生，看小程序 Console：
`[dancehub] 订阅授权返回: {"<模板ID>":"accept", "errMsg":"requestSubscribeMessage:ok"}`。
只有出现 `accept` 时，`reminder.routes.js` 才会把 `subscribeTplId` 写进去。

### YouTube 视频预览

云调用只代理微信自己的接口，代理不了 `googleapis.com` —— 这个只能给容器开公网出口，或砍掉。
