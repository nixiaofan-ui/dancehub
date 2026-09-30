/**
 * 距离计算与「按距离排序」的烟测。
 *
 * 为什么单独测它：这段逻辑算错了**界面上完全看不出来** —— 距离数字照样显示、
 * 列表照样有顺序，只有把地图铺开才发现店全跑到非洲去了。所以断言要覆盖
 * ① 距离量级对不对 ② 坐标写反/0 值能不能挡住 ③ 没坐标的店是不是「排后面」而不是「消失」。
 */
const path = require("path");

const MINIAPP = path.join(__dirname, "..", "miniapp");
const { distanceKm, distanceText, llOf, sortByDistance } = require(path.join(MINIAPP, "utils/geo.js"));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("  ✔ " + name);
  } else {
    fail += 1;
    console.log("  ✖ " + name + (extra ? " → " + extra : ""));
  }
}

console.log("距离与排序烟测");

// ① 距离量级：人民广场 → 虹桥火车站，实际约 15km
const km = distanceKm(31.2304, 121.4737, 31.1943, 121.3244);
check("距离量级正确（上海两站间 ≈15km）", km > 14 && km < 17, km.toFixed(2) + "km");
check("同点距离为 0", distanceKm(31.2, 121.4, 31.2, 121.4) < 0.001);

// ② 分档文案：刻意不给精确值
check("<1km 档", distanceText(0.6) === "<1km", distanceText(0.6));
check("1-3km 档", distanceText(2.4) === "1-3km", distanceText(2.4));
check("3-5km 档", distanceText(4.1) === "3-5km", distanceText(4.1));
check("5km+ 档", distanceText(12) === "5km+", distanceText(12));
check("非法值不显示", distanceText(NaN) === "");

// ③ 坐标校验：挡住脏数据
check("0,0 判为无坐标", llOf({ lat: 0, lng: 0 }) === null);
check("缺坐标判为无", llOf({}) === null && llOf(null) === null);
check("字符串坐标可用", !!llOf({ lat: "31.23", lng: "121.47" }));
check(
  "经纬度写反被挡住（121 当纬度）",
  llOf({ lat: 121.47, lng: 31.23 }) === null,
);

// ④ 排序：有距离的升序在前，没坐标的**保持原顺序**跟在后面
const origin = { lat: 31.2304, lng: 121.4737 };
const rows = [
  { id: 1, name: "无坐标A" },
  { id: 2, name: "远", lat: 31.1943, lng: 121.3244 },
  { id: 3, name: "近", lat: 31.228, lng: 121.4755 },
  { id: 4, name: "无坐标B" },
  { id: 5, name: "中", lat: 31.22, lng: 121.45 },
];
const r = sortByDistance(rows, origin, (x) => llOf(x));
check("未知坐标数量 = 2", r.unknownCount === 2, String(r.unknownCount));
check("总数不变（没坐标的没被丢掉）", r.list.length === 5, String(r.list.length));
check("最近的排第一", r.list[0].id === 3, r.list.map((x) => x.id).join(","));
check(
  "有距离的三家按升序：近 < 中 < 远",
  r.list[0]._km < r.list[1]._km && r.list[1]._km < r.list[2]._km,
  r.list.slice(0, 3).map((x) => x._km.toFixed(1)).join(","),
);
check("有距离的都排在前", r.list.slice(0, 3).every((x) => x._km != null));
check(
  "没坐标的保原序跟在后面（A 在 B 前）",
  r.list[3].id === 1 && r.list[4].id === 4,
  r.list.slice(3).map((x) => x.id).join(","),
);
check("没坐标的不带距离文案", r.list[3]._dist === "" && r.list[4]._km === null);
check("距离文案随行带出", r.list[0]._dist === distanceText(r.list[0]._km));

// ⑤ 没有定位点：原样返回，一格不动
const noOrigin = sortByDistance(rows, null, (x) => llOf(x));
check("无定位时不排序", noOrigin.sorted === false);
check("无定位时保持原顺序", noOrigin.list.map((x) => x.id).join(",") === "1,2,3,4,5");
check("无定位时不产生距离文案", noOrigin.list.every((x) => !x._dist));

console.log(fail ? "\n✖ " + fail + " 项失败（通过 " + pass + "）" : "\n✔ 全部通过（" + pass + " 项）");
process.exit(fail ? 1 : 0);
