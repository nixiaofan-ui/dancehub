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
 *
 * ⚠ 档位按**大城市通勤直觉**切，不按里程刻度切。
 *   原来的最后一档是「5km+」，而实测同城门店两两距离：5km 以上占 86%，
 *   光 20km+ 就占一半 —— 那一档等于没有区分能力（5.1km 和 50km 显示同一个词），
 *   反馈原话是「在大城市 5km 不过是几站地铁而已」。
 *   现在的语义分层：
 *     <1km    走过去 / 骑车 5 分钟
 *     1-3km   骑车十几分钟，懒得走但完全在同城生活圈内
 *     3-6km   几站地铁，日常可接受
 *     6-10km  要专门跑一趟，但还在「愿意去」的范围
 *     10-20km 跨半个城，只有老师特别好才去
 *     20km+   基本是跨区/邻近城市（也顺带兜住城市挂错的脏数据）
 *   中间那条 6km 的线：5km 在北上广深这种尺度里确实还是「近」，8km 以上
 *   就进入「要计划一下」的心理区间，6 是这两者的分水岭。
 */
function distanceText(km) {
  const k = Number(km);
  if (!Number.isFinite(k)) return "";
  if (k < 1) return "<1km";
  if (k < 3) return "1-3km";
  if (k < 6) return "3-6km";
  if (k < 10) return "6-10km";
  if (k < 20) return "10-20km";
  return "20km+";
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
