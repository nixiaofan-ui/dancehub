/**
 * 登录入口（网关 / 公网）与身份来源的烟测。
 *
 * 2026-10-08 线上实测出的漏洞：`/api/auth/login` 无条件信任网关注入的
 * `x-wx-openid`，而本服务的公网访问是**开着**的 ——
 *
 *     curl -X POST https://<服务域名>/api/auth/login -H 'x-wx-openid: 任意值' -d '{}'
 *     → 登录成功，user 表 +1（每换一个值就 +1）
 *
 * 根因是**把「一个请求头」当成了凭据**：公网请求能完整伪造 x-wx-* 头，
 * 网关既不会拦也不会剥（实测）。真正不可伪造的是 code（wx.login 签发、
 * 一次性、绑定 appid），而小程序本来就每次都带 code。
 *
 * 所以修法是：**code 是首选，网关头降级为受控兜底**。
 * 这个测试要钉住的就是这句话，尤其是：
 *   ⛔ 公网入口 + 伪造 x-wx-openid + 拿不出有效 code → 必须 401，且**一个账号都不能建**。
 *
 *   cd server && /usr/local/bin/node --import ../tools/prisma-stub-hooks.mjs ../tools/smoke-auth-entry.mjs
 */
import { register } from "node:module";
import { once } from "node:events";
import { createRequire } from "node:module";

register(new URL("./prisma-stub-hooks.mjs", import.meta.url));

// 必须按 server 的依赖树解析（express 装在 server/node_modules，不在仓库根）
const requireFromServer = createRequire(new URL("../server/package.json", import.meta.url));

// 必须在 config.js 被 import 之前设好（config 在模块求值时读 env；dotenv 不覆盖已存在的变量）
process.env.WECHAT_APPID = "wx-test-appid-0001";
process.env.WECHAT_SECRET = "test-secret-0001";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.GATEWAY_IDENTITY = "auto";

const express = requireFromServer("express");
const { default: authRoutes } = await import("../server/src/routes/auth.routes.js");
const { tagEntry, classifyEntry, ENTRY_GATEWAY, ENTRY_PUBLIC } = await import(
  "../server/src/middleware/entry.js"
);
const { config } = await import("../server/src/config.js");
const { __resetChannelState } = await import("../server/src/services/auth.service.js");
const { prisma, __reset } = await import(new URL("./testing/fake-prisma-stub.mjs", import.meta.url));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${label}${ok ? "" : `  得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`);
}

// ── 假 fetch：接管 api.weixin.qq.com，否则这个测试会真的打微信 ──────────────
// ⚠ 先留一份真实 fetch：下面的 login() 要拿它打本地 express，
//   否则连自己的请求都会被桩吞掉（表现是「200 但 data 是 undefined」，很费解）。
const realFetch = globalThis.fetch;
const APPID = config.wechat.appId;
let fetchMode = "ok"; // ok | authError | channelError
let fetchUrls = [];
globalThis.fetch = async (url) => {
  fetchUrls.push(String(url));
  if (fetchMode === "channelError") throw new Error("fetch failed");
  const body =
    fetchMode === "authError"
      ? { errcode: 40029, errmsg: "invalid code, rid: smoke" }
      : { openid: "oVERIFIED", session_key: "sk-smoke" };
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
};

// ── 起一个最小 express（只挂入口标签 + 登录路由）────────────────────────────
const app = express();
app.use(express.json());
app.use(tagEntry);
app.use("/api/auth", authRoutes);
const server = app.listen(0);
await once(server, "listening");
const BASE = `http://127.0.0.1:${server.address().port}`;

async function login(headers = {}, body = {}) {
  const res = await realFetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const userCount = async () => (await prisma.user.findMany({})).length;
const openids = async () => (await prisma.user.findMany({})).map((u) => u.openid);

console.log("── 入口判定（classifyEntry）────────────────────────────────");

check("无 x-wx-openid → 公网", classifyEntry({}), {
  entry: ENTRY_PUBLIC,
  why: "no-gateway-openid",
});
check("有 openid、上游没给 appid → 网关", classifyEntry({ "x-wx-openid": "o1" }), {
  entry: ENTRY_GATEWAY,
  why: "gateway-openid-no-appid",
});
check(
  "openid + appid 与本小程序一致 → 网关",
  classifyEntry({ "x-wx-openid": "o1", "x-wx-appid": APPID }),
  { entry: ENTRY_GATEWAY, why: "gateway-openid-appid" }
);
check(
  "openid + appid 对不上 → 公网（脏头不当网关）",
  classifyEntry({ "x-wx-openid": "o1", "x-wx-appid": "wx-SOMEONE-ELSE" }),
  { entry: ENTRY_PUBLIC, why: "appid-mismatch" }
);

console.log("\n── ① 首选：身份由 code 证明 ────────────────────────────────");

__reset();
__resetChannelState();
fetchMode = "ok";
let r = await login({}, { code: "code-valid" });
check("带有效 code → 200", r.status, 200);
check("via 指明走的是云调用通道", r.json.data.via, "code2session:cloud-call");
check("账号用的是 code 换回的 openid", await openids(), ["oVERIFIED"]);
check("响应回传入口（排障用）", r.json.data.entry, "public");

// 同一 openid 再登一次不能建第二个号
r = await login({}, { code: "code-valid" });
check("重复登录不新建账号", await userCount(), 1);

__resetChannelState();
r = await login({}, { code: "code-valid" });
check("第二次登录自增 id 不变（幂等）", r.json.data.user.id, 1);

console.log("\n── ⛔ ② 核心回归：伪造网关头不能当身份 ─────────────────────");

__resetChannelState();
fetchMode = "ok";
r = await login({ "x-wx-openid": "oFORGED-1" }, {});
check("⛔ 无 code + 伪造 openid → 401", r.status, 401);
check("⛔ 且没有建号（修复前这里会 +1）", await userCount(), 1);

__resetChannelState();
r = await login({ "x-wx-openid": "oFORGED-2" }, {});
check("⛔ 换一个伪造值再来一次 → 401", r.status, 401);
check("⛔ 依然没建号", await userCount(), 1);

__resetChannelState();
r = await login({ "x-wx-openid": "oFORGED-3", "x-wx-appid": "wx-NOT-MINE" }, {});
check("⛔ 伪造 openid + 别人的 appid → 401", r.status, 401);
check("⛔ 依然没建号", await userCount(), 1);

// 有有效 code 时，即使同时带了伪造头，也必须采信 code 换回的身份
__resetChannelState();
fetchMode = "ok";
r = await login({ "x-wx-openid": "oFORGED-4", "x-wx-appid": APPID }, { code: "code-valid" });
check("code 有效时优先采信 code → 200", r.status, 200);
check("用的仍是 code 的 openid，不是头里的", await openids(), ["oVERIFIED"]);

console.log("\n── ③ 通道不可用时的受控降级（auto）────────────────────────");

__resetChannelState();
fetchMode = "channelError";
r = await login({ "x-wx-openid": "oGW-1", "x-wx-appid": APPID }, { code: "code-x" });
check("通道挂了 + 网关入口 → 允许网关头兜底", r.status, 200);
check("via 标明这是降级", r.json.data.via, "gateway:channel-down");
check("入口被认成网关", r.json.data.entry, "gateway");
check("建了号", await openids(), ["oVERIFIED", "oGW-1"]);

__resetChannelState();
fetchMode = "channelError";
r = await login({ "x-wx-openid": "oPUB-1", "x-wx-appid": "wx-NOT-MINE" }, { code: "code-x" });
check("⛔ 通道挂了 + 公网入口（appid 对不上）→ 依然拒绝", r.status, 401);
check("⛔ 没有建号", await userCount(), 2);

__resetChannelState();
fetchMode = "channelError";
r = await login({}, { code: "code-x" });
check("通道挂了且没有网关头 → 502 而不是 200", r.status, 502);

console.log("\n── ④ 策略 off / always ────────────────────────────────────");

config.gatewayIdentity = "off";
__resetChannelState();
fetchMode = "ok";
r = await login({ "x-wx-openid": "oOFF-1", "x-wx-appid": APPID }, {});
check("off + 伪造头（就算入口判成网关）→ 401", r.status, 401);
check("off 下不建号", await userCount(), 2);

__resetChannelState();
fetchMode = "channelError";
r = await login({ "x-wx-openid": "oOFF-2", "x-wx-appid": APPID }, { code: "code-x" });
check("off + 通道挂了 → 不降级，401", r.status, 401);

__resetChannelState();
fetchMode = "ok";
r = await login({}, { code: "code-valid" });
check("off 下 code 仍然可用", r.status, 200);
check("off 下 via 仍是 code2session", r.json.data.via, "code2session:cloud-call");

config.gatewayIdentity = "always";
__resetChannelState();
fetchMode = "ok";
r = await login({ "x-wx-openid": "oALW-1", "x-wx-appid": APPID }, {});
check("always → 直接采信网关头", r.status, 200);
check("via 标明 always", r.json.data.via, "gateway:always");

config.gatewayIdentity = "auto";

console.log("\n── ⑤ code 无效：微信明确拒绝 ──────────────────────────────");

__resetChannelState();
fetchMode = "authError";
r = await login({ "x-wx-openid": "oBAD-1", "x-wx-appid": APPID }, { code: "code-bad" });
check("⛔ 微信拒绝这个 code → 401（不降级到网关头）", r.status, 401);
check("⛔ 没有建号", await userCount(), 3);

__resetChannelState();
fetchMode = "authError";
r = await login({}, {});
check("既没 code 也没网关头 → 400", r.status, 400);

console.log("\n── ⑥ 通道选择 ────────────────────────────────────────────");

__resetChannelState();
fetchMode = "ok";
fetchUrls = [];
await login({}, { code: "code-valid" });
check("首选 http 的云调用通道（容器无公网出口时唯一通路）", fetchUrls[0].startsWith("http://api.weixin.qq.com/sns/jscode2session"), true);
check("没有白打一次 https", fetchUrls.length, 1);

// 云调用挂了 → 回落 https 公网通道
__resetChannelState();
let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  if (String(url).startsWith("http://")) throw new Error("cloud down");
  return { ok: true, status: 200, json: async () => ({ openid: "oHTTPS", session_key: "sk" }) };
};
r = await login({}, { code: "code-valid" });
check("云调用挂 → 回落公网 https", r.json.data.via, "code2session:https-public");
check("两个通道各试了一次", calls, 2);

console.log("\n── ⑦ 用户表最终状态 ──────────────────────────────────────");
check("全部伪造尝试一个号都没建出来", await userCount(), 4);
check(
  "账号清单（只有 code 证明过的 + 唯一一次受控降级）",
  (await openids()).sort(),
  ["oALW-1", "oGW-1", "oHTTPS", "oVERIFIED"].sort()
);

server.close();
console.log(failed ? `\n✖ ${failed} 项未通过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
