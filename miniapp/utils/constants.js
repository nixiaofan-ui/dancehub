const DIFF_LABEL = {
  BEGINNER: "入门",
  INTERMEDIATE: "初级",
  ADVANCED: "高级",
  ALL_LEVELS: "不限",
};

const PLATFORM_LABEL = {
  WECHAT: "门店小程序",
  NAVER: "Naver",
  INSTAGRAM: "Instagram",
  YOUTUBE: "YouTube",
  // 海外场馆（1MILLION / JustJerk / rawgraphy 系等）统一归到这里，
  // 展示为「官网」比「其他」更清楚：用户知道点进去是去官方网站
  OTHER: "官网",
};

const BOOKING_STATUS_LABEL = {
  PENDING: "未确认",
  CONFIRMED: "已约好",
};

module.exports = { DIFF_LABEL, PLATFORM_LABEL, BOOKING_STATUS_LABEL };