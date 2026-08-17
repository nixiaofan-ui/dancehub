const { API_BASE } = require("./config");

function request(method, url, data) {
  const app = getApp();
  const token = app && app.globalData.token ? app.globalData.token : "";

  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE + url,
      method,
      data,
      header: {
        "content-type": "application/json",
        Authorization: token ? "Bearer " + token : "",
      },
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

module.exports = {
  get: (url, data) => request("GET", url, data),
  post: (url, data) => request("POST", url, data),
  put: (url, data) => request("PUT", url, data),
  delete: (url) => request("DELETE", url),
};