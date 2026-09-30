/**
 * 距离计算与「按距离排序」。
 *
 * 坐标一律 GCJ-02（火星坐标），和 wx.getFuzzyLocation({ type: "gcj02" })、
 * 腾讯/高德地图同一套，直接算，不要再换算 —— 混用 WGS-84 会整体偏移几百米。
 */

const R = 6371; // 地球平均半径（km）

/** 两点球面距离（km） */
function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function llOf(item) {
  if (!item) return null;
  const lat = Number(item.lat);
  const lng = Number(item.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // 国内大致范围：挡住 0,0 和经纬度写反的脏数据（写反会落到非洲西海岸）
  if (lat < 3 || lat > 54 || lng < 73 || lng > 136) return null;
  return { lat, lng };
}

/**
 * 距离文案用**分档**而不是精确值。
 *
 * 定位走的是模糊定位（getFuzzyLocation），本身有百米级误差，显示「1.23km」
 * 是假精度 —— 用户会拿去和高德对比，然后觉得我们的数据不准。分档既诚实又抗误差。
 */
function distanceText(km) {
  const k = Number(km);
  if (!Number.isFinite(k)) return "";
  if (k < 1) return "<1km";
  if (k < 3) return "1-3km";
  if (k < 5) return "3-5km";
  return "5km+";
}

/**
 * 按离 origin 的距离升序排；**没有坐标的保持原顺序跟在后面**。
 *
 * ⚠ 两条底线：
 *   1. 绝不拿城市中心点/默认值顶替缺失坐标 —— 那会显示一个看起来真实、实际
 *      是编造的距离，用户会照着它跑去一个不存在的地方；
 *   2. 也不把没坐标的沉底后隐藏 —— 覆盖率本来就不满，隐藏等于让用户以为没收录。
 *
 * @param {any[]} rows
 * @param {{lat:number,lng:number}|null} origin 定位点；null 表示没定位
 * @param {(row:any)=>{lat:number,lng:number}|null} [getLL] 取坐标（默认读 row.lat/lng）
 * @returns {{list: any[], unknownCount: number, sorted: boolean}}
 *          每行会挂上 _km（number|null）和 _dist（分档文案）
 */
function sortByDistance(rows, origin, getLL) {
  const pick = getLL || llOf;
  const withKm = [];
  const without = [];
  rows.forEach((r, i) => {
    const ll = pick(r);
    if (origin && ll) {
      const km = distanceKm(origin.lat, origin.lng, ll.lat, ll.lng);
      withKm.push({ r: { ...r, _km: km, _dist: distanceText(km) }, km, i });
    } else {
      without.push({ r: { ...r, _km: null, _dist: "" }, i });
    }
  });
  if (!origin) {
    return { list: rows.map((r) => ({ ...r, _km: null, _dist: "" })), unknownCount: rows.length, sorted: false };
  }
  withKm.sort((a, b) => a.km - b.km || a.i - b.i);
  return {
    list: [...withKm.map((x) => x.r), ...without.map((x) => x.r)],
    unknownCount: without.length,
    sorted: true,
  };
}

module.exports = { distanceKm, distanceText, llOf, sortByDistance };
