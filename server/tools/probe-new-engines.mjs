/**
 * 临时探针：直接调 crawl() 验证四个新引擎能否拉到真实课表。
 * 用法：cd server && node tools/probe-new-engines.mjs
 */
import { crawl } from "../src/crawler/engine.js";

const date = new Date("2026-09-30T00:00:00Z");

const cases = [
  [
    "咪哩约课 / PREFER DANCE",
    {
      mode: "miliyoga",
      studio: { name: "PREFER DANCE" },
      miliyoga: {
        places: [
          { pk: "9iwjnvceyz", name: "钻石店" },
          { pk: "agtjrk8m1b", name: "金牛店" },
          { pk: "6ypti3r08m", name: "泛悦店" },
          { pk: "box7ifd4n2", name: "少儿" },
        ],
      },
    },
  ],
  [
    "一只鸟 / 舞岚舞蹈实验室",
    {
      mode: "yizhiniao",
      studio: { name: "舞岚舞蹈实验室" },
      yizhiniao: { shops: [{ id: "62402" }, { id: "62404" }] },
    },
  ],
  [
    "舞空云 / HTD舞蹈工作室",
    {
      mode: "haowan",
      studio: { name: "HTD舞蹈工作室" },
      haowan: { gyms: [{ id: 1, name: "HTD舞蹈工作室" }] },
    },
  ],
  [
    "青橙 / UNLABEL&舞厂牌",
    {
      mode: "qingcheng",
      studio: { name: "UNLABEL&舞厂牌" },
      qingcheng: { shops: [{ id: "72128", name: "厚街店" }] },
    },
  ],
];

for (const [label, cfg] of cases) {
  try {
    const rows = await crawl(cfg, date);
    console.log(`\n=== ${label} ===  抓到 ${rows.length} 条`);
    for (const r of rows.slice(0, 3)) {
      console.log(
        `  ${r._studioName} | ${r.courseName} | ${r.coach} | ${r.time} | cap=${r.capacity} booked=${r._bookedNum} | room=${r._roomName || "-"}`,
      );
    }
  } catch (e) {
    console.log(`\n=== ${label} ===  ❌ ${e.message}`);
  }
}
