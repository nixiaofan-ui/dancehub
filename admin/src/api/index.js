import http from "./http.js";

export const adminApi = {
  check: () => http.get("/admin/check"),
  bookings: (scheduleDate) =>
    http.get("/admin/bookings", { params: scheduleDate ? { scheduleDate } : {} }),
};

export const cityApi = {
  list: (region) => http.get("/cities", { params: region ? { region } : {} }),
};

export const studioApi = {
  list: (params) => http.get("/studios", { params }),
  create: (data) => http.post("/studios", data),
  update: (id, data) => http.put(`/studios/${id}`, data),
  remove: (id) => http.delete(`/studios/${id}`),
};

export const coachApi = {
  list: (studioId) => http.get("/coaches", { params: studioId ? { studioId } : {} }),
  create: (data) => http.post("/coaches", data),
  update: (id, data) => http.put(`/coaches/${id}`, data),
  remove: (id) => http.delete(`/coaches/${id}`),
};

export const scheduleApi = {
  list: (params) => http.get("/schedules", { params }),
  create: (data) => http.post("/schedules", data),
  update: (id, data) => http.put(`/schedules/${id}`, data),
  remove: (id) => http.delete(`/schedules/${id}`),
  copyPreviousWeek: (data) => http.post("/schedules/copy-previous-week", data),
};

export const bookingApi = {
  list: () => http.get("/bookings"),
};

export const common = {
  difficultyLabel: {
    BEGINNER: "入门",
    INTERMEDIATE: "初级",
    ADVANCED: "高级",
    ALL_LEVELS: "不限",
  },
  platformLabel: {
    WECHAT: "门店小程序",
    NAVER: "Naver",
    INSTAGRAM: "Instagram",
    OTHER: "其他",
  },
  bookingStatusLabel: {
    PENDING: "未确认",
    CONFIRMED: "已约好",
  },
  bookingMethodLabel: {
    JUMP: "跳转",
    MANUAL: "手动",
  },
};