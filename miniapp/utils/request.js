const { API_BASE, USE_CLOUD, CLOUD_RUNNER_ID, CLOUD_SERVICE_NAME } = require("./config");

const cloudReady = () => USE_CLOUD && typeof wx.cloud !== "undefined" && CLOUD_RUNNER_ID && !CLOUD_RUNNER_ID.startsWith("REPLACE_ME");

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

function callContainer(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: CLOUD_RUNNER_ID },
      path: path.startsWith("/api") ? path : "/api" + path,
      method,
      header: withToken(method, data),
      data,
      success(res) {
        const body = res.data;
        if (res.statusCode === 401) {
          wx.showToast({ title: "登录失效，请重启小程序", icon: "none" });
          return reject(new Error("unauthorized"));
        }
        if (body && body.code === 0) return resolve(body.data);
        reject(new Error((body && body.message) || `云托管返回 ${res.statusCode}`));
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
        const body = res.data;
        if (res.statusCode === 401) {
          wx.showToast({ title: "登录失效，请重启小程序", icon: "none" });
          return reject(new Error("unauthorized"));
        }
        if (body && body.code === 0) return resolve(body.data);
        reject(new Error((body && body.message) || "请求失败"));
      },
      fail(err) {
        const msg = (err && err.errMsg) || "";
        // 微信把失败原因全塞在 errMsg 里。以前直接吞掉只回一句「网络错误」，
        // 于是「域名没配」「真机上连 localhost」「服务端没起」三种完全不同的
        // 故障在界面上长得一模一样，只能靠猜。这里把原始原因打出来。
        console.error("[DanceHub] 请求失败", method, API_BASE + path, "→", msg);
        // 最常见的两种：合法域名未配置 / 真机连了 localhost
        if (msg.indexOf("合法域名") >= 0) {
          console.error(
            "[DanceHub] 需在开发者工具「详情 → 本地设置」勾选「不校验合法域名」。" +
              "注意：该开关只对开发者工具和真机调试生效，体验版/正式版无效。"
          );
        } else if (msg.indexOf("localhost") >= 0 || msg.indexOf("127.0.0.1") >= 0) {
          console.error(
            "[DanceHub] 真机上 localhost 指的是手机自身，不是你的电脑。" +
              "真机调试请把 API_BASE 换成电脑的局域网 IP，或改用云托管（USE_CLOUD=true）。"
          );
        }
        reject(new Error(msg ? "网络错误：" + msg : "网络错误，请检查后端服务"));
      },
    });
  });
}

function request(method, path, data) {
  return cloudReady() ? callContainer(method, path, data) : callRequest(method, path, data);
}

module.exports = {
  get: (p, d) => request("GET", p, d),
  post: (p, d) => request("POST", p, d),
  put: (p, d) => request("PUT", p, d),
  delete: (p) => request("DELETE", p),
};