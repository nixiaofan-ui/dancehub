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
      fail() {
        reject(new Error("网络错误，请检查后端服务"));
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