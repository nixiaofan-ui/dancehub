const {
  API_BASE,
  API_HOST,
  USE_CLOUD,
  CLOUD_RUNNER_ID,
  CLOUD_SERVICE_NAME,
} = require("./config");
const { devDeviceId } = require("./device");

// 网络故障会让每个请求都失败，指引只弹一次，否则整屏 toast 乱闪
let networkHinted = false;

const cloudReady = () => USE_CLOUD && typeof wx.cloud !== "undefined" && CLOUD_RUNNER_ID && !CLOUD_RUNNER_ID.startsWith("REPLACE_ME");

/**
 * 请求超时上限（毫秒）。
 *
 * 为什么必须有：wx.cloud.callContainer 没有内置的 timeout 参数（wx.request 才有）。
 * 云托管遇到冷启动（最小实例数为 0 时首次拉起要几十秒）或服务异常时，
 * 这个 Promise 可以一直 pending 不返回。而 app.js 的 init() 会 await 它、
 * 页面又 await app.ready —— 三层串起来，onLaunch 迟迟结束不了，
 * 微信直接判 `appLaunch timeout`，用户看到的画面就是**一片背景色**：
 * 既没内容也没报错，只能靠猜是代码坏了还是服务挂了。
 *
 * 加了超时以后，故障变成可感知的错误，由调用方兜底渲染并给出重试入口，
 * 而不是把首屏一直按在空白上。
 */
const REQUEST_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, tag) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error("[DanceHub] 请求超时", tag, `${ms}ms —— 按失败处理，界面走兜底渲染`);
      reject(new Error(`${tag} 超时：服务 ${ms / 1000} 秒无响应`));
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function withToken(method, data) {
  const app = getApp();
  const token = app && app.globalData.token ? app.globalData.token : "";
  return {
    "content-type": "application/json",
    "X-WX-FROM": "miniapp",
    "X-WX-SERVICE": CLOUD_SERVICE_NAME,
    Authorization: token ? "Bearer " + token : "",
  };
}

/**
 * 401 单独成类：调用方要区分「token 过期，重新登录再来一次就行」
 * 和「网关直接把人拦在门外，重登多少次都没用」这两种完全不同的故障。
 * body 带上原始响应 —— 网关 401 和业务 401 长得不一样，看一眼就能分辨。
 */
function Unauthorized(body, meta) {
  this.name = "Unauthorized";
  this.message = "unauthorized";
  this.body = body;
  this.meta = meta || {};
}
Unauthorized.prototype = Object.create(Error.prototype);
Unauthorized.prototype.constructor = Unauthorized;

const isLoginPath = (p) => String(p).replace(/^\/api/, "").split("?")[0] === "/auth/login";

/**
 * 业务失败时把服务端返回的 body 整个挂在 error 上 —— 光有 message 不够用。
 * 例：撞课时服务端回 409 + data.conflicts，前端要拿它拼「和哪一节课冲突」的弹窗文案。
 */
function buildError(body, fallback) {
  const err = new Error((body && body.message) || fallback);
  err.body = body || null;
  return err;
}

function callContainer(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: CLOUD_RUNNER_ID },
      path: path.startsWith("/api") ? path : "/api" + path,
      method,
      header: withToken(method, data),
      data,
      success(res) {
        if (res.statusCode === 401) {
          console.error("[DanceHub] 401 ←", method, path, "原始响应:", res.data);
          return reject(new Unauthorized(res.data, { via: "cloud", path }));
        }
        const body = res.data;
        if (body && body.code === 0) return resolve(body.data);
        reject(buildError(body, `云托管返回 ${res.statusCode}`));
      },
      fail(err) {
        reject(new Error("云托管调用失败：" + (err.errMsg || err.message || "")));
      },
    });
  });
}

function callRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE + path,
      method,
      data,
      header: withToken(method, data),
      success(res) {
        if (res.statusCode === 401) {
          console.error("[DanceHub] 401 ←", method, API_BASE + path, "原始响应:", res.data);
          return reject(new Unauthorized(res.data, { via: "http", path }));
        }
        const body = res.data;
        if (body && body.code === 0) return resolve(body.data);
        reject(buildError(body, "请求失败"));
      },
      fail(err) {
        const msg = (err && err.errMsg) || "";
        // 微信把失败原因全塞在 errMsg 里。以前直接吞掉只回一句「网络错误」，
        // 于是「域名没配」「真机上连 localhost」「服务端没起」三种完全不同的
        // 故障在界面上长得一模一样，只能靠猜。这里把原始原因打出来。
        console.error("[DanceHub] 请求失败", method, API_BASE + path, "→", msg);
        // 最常见的两种：合法域名未配置 / 真机连了 localhost
        // errMsg 里通常不含 URL，判断地址要用 API_HOST 而不是 msg
        const isDomainBlock = msg.indexOf("合法域名") >= 0;
        const isLoopback = API_HOST === "localhost" || API_HOST === "127.0.0.1";
        if (isDomainBlock) {
          console.error(
            "[DanceHub] 需在开发者工具「详情 → 本地设置」勾选「不校验合法域名」。" +
              "注意：该开关只对开发者工具和真机调试生效，体验版/正式版无效。"
          );
        } else if (isLoopback) {
          console.error(
            "[DanceHub] 真机上 localhost 指的是手机自身，不是你的电脑。" +
              "真机调试请把 API_BASE 换成电脑的局域网 IP，或改用云托管（USE_CLOUD=true）。"
          );
        }
        // 光有「连不上 localhost」用户还是不知道下一步，直接把动作说出来
        if (!networkHinted && (isDomainBlock || isLoopback)) {
          networkHinted = true;
          wx.showToast({
            title: isDomainBlock
              ? "请勾选「不校验合法域名」"
              : "真机请用局域网 IP 代替 localhost",
            icon: "none",
            duration: 4000,
          });
        }
        reject(new Error(msg ? "网络错误：" + msg : "网络错误，请检查后端服务"));
      },
    });
  });
}

// 不带任何重试的裸调用，避免自动重登逻辑里再套自动重登（死循环）
function raw(method, path, data) {
  const p = cloudReady() ? callContainer(method, path, data) : callRequest(method, path, data);
  return withTimeout(p, REQUEST_TIMEOUT_MS, `${method} ${path}`);
}

// 401 时并发请求会一起失败，只重登一次拿新 token，别把 wx.login 打爆
let reloginTask = null;

function relogin() {
  if (reloginTask) return reloginTask;
  reloginTask = new Promise((resolve, reject) => {
    wx.login({
      success: async (r) => {
        try {
          const data = await raw("POST", "/auth/login", { code: r.code, devId: devDeviceId() });
          const app = getApp();
          if (app) app.globalData.token = data.token;
          resolve(data.token);
        } catch (e) {
          reject(e);
        }
      },
      fail: reject,
    });
  }).then(
    (t) => {
      reloginTask = null;
      return t;
    },
    (e) => {
      reloginTask = null;
      throw e;
    }
  );
  return reloginTask;
}

/**
 * 统一出口：token 过期自动重登并重试一次。
 * 以前 401 一律弹「登录失效，请重启小程序」—— 于是两件完全不同的事被混成一件事：
 *   1) token 真过期：本来静默换一个就好，却把用户赶去手动重启；
 *   2) 网关层 401（实例为 0 / 环境欠费停服 / 服务名或环境 ID 不对）：
 *      重启一百次也没用，用户只会觉得「重启了也没数据」。
 * 现在：业务接口 401 → 静默重登重试；登录接口自己 401 → 直接说是服务端没放行。
 */
async function request(method, path, data) {
  try {
    return await raw(method, path, data);
  } catch (e) {
    if (!(e instanceof Unauthorized)) throw e;

    if (isLoginPath(path)) {
      console.error(
        "[DanceHub] /auth/login 被 401 拦下 —— 这不是 token 过期，是请求根本没进到容器。\n" +
          "按顺序查：① 云托管服务是否有 normal 版本且流量 100%；② 最小实例数是否被设成 0（缩容后冷启动会拒请求）；" +
          "③ 环境是否欠费/停服；④ config.js 的 CLOUD_RUNNER_ID / CLOUD_SERVICE_NAME 是否与控制台一致。"
      );
      wx.showToast({ title: "云服务未放行（401）", icon: "none", duration: 4000 });
      throw e;
    }

    try {
      await relogin();
      return await raw(method, path, data);
    } catch (e2) {
      console.error("[DanceHub] 自动重登后仍失败:", e2 && e2.message);
      wx.showToast({ title: "登录失效，重试后仍失败", icon: "none", duration: 3000 });
      throw e2;
    }
  }
}

module.exports = {
  get: (p, d) => request("GET", p, d),
  post: (p, d) => request("POST", p, d),
  put: (p, d) => request("PUT", p, d),
  delete: (p) => request("DELETE", p),
  // 供页面/诊断脚本直接看服务端真实返回，绕开自动重登
  raw,
};
