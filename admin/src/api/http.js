import axios from "axios";

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || "/api",
  timeout: 15000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem("admin_token");
  if (token) config.headers["x-admin-token"] = token;
  return config;
});

http.interceptors.response.use(
  (resp) => {
    const body = resp.data;
    if (body && body.code !== 0) {
      return Promise.reject(new Error(body.message || "请求失败"));
    }
    return body.data;
  },
  (err) => {
    const msg = err.response?.data?.message || err.message || "网络错误";
    if (err.response?.status === 403) {
      localStorage.removeItem("admin_token");
      if (!location.hash.includes("/login")) location.hash = "#/login";
    }
    return Promise.reject(new Error(msg));
  },
);

export default http;