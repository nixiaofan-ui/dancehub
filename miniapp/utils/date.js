function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

function dateKey(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function todayKey() {
  return dateKey(new Date());
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatChip(d) {
  return {
    key: dateKey(d),
    day: WEEK[d.getDay()],
    date: (d.getMonth() + 1) + "/" + d.getDate(),
    isToday: dateKey(d) === todayKey(),
  };
}

module.exports = { dateKey, parseKey, addDays, todayKey, formatChip, WEEK };