/**
 * 教练头像的烟测。
 *
 * 为什么单独测它：头像错了**不会报错也不会空白**，只会「每张卡都是同一张灰脸」
 * 或者「头像整片不显示」，两种都很容易被当成「这平台就是没头像」而放过去。
 * 断言覆盖：① 默认占位图要挡掉 ② 非法字符要转义 ③ 真头像要原样保留。
 */
const path = require("path");

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

console.log("教练头像烟测");

const enginePath = path.join(
  __dirname,
  "..",
  "server",
  "src",
  "crawler",
  "engine.js",
);

// engine.js 是 ESM 且顶层 import 了一堆东西，.mjs 里直接 import 会连带求值。
// 用动态 import 拿纯函数；加载失败（依赖缺失）时明确报出来，别静默跳过。
(async () => {
  let pickImageUrl;
  try {
    const mod = await import("file://" + enginePath);
    pickImageUrl = mod.pickImageUrl;
  } catch (e) {
    console.log("  ✖ 无法加载 engine.js → " + e.message);
    process.exit(1);
  }
  if (typeof pickImageUrl !== "function") {
    console.log("  ✖ pickImageUrl 未导出");
    process.exit(1);
  }

  // ① 真头像要原样保留（不能因为转义把正常 URL 改坏）
  const ok1 = "https://fityun-mall-cdn.fityun.cn/cloud/teacher/origin/1621577440.png?x-oss-process=image/resize,m_fixed,h_240,w_240";
  check("正常 URL 原样返回", pickImageUrl(ok1) === ok1);

  // ② 上游「没头像」时给的是默认占位图，必须挡掉 —— 否则所有老师同一张灰脸
  check(
    "默认占位图判为无头像",
    pickImageUrl("https://fityun-mall-cdn.fityun.cn/default/customer/default.png") === null,
  );
  check(
    "default_avatar 判为无头像",
    pickImageUrl("https://x.cn/img/default_avatar.png") === null,
  );

  // ③ 空值 / 脏值
  check("空串判为无头像", pickImageUrl("") === null);
  check("null 判为无头像", pickImageUrl(null) === null);
  check("非 http 判为无头像", pickImageUrl("ftp://x.cn/a.png") === null);
  check("相对路径判为无头像", pickImageUrl("/img/a.png") === null);

  // ④ 非法字符转义：菲体云老师图路径里真的有 `}`，不转会被图片加载器判非法
  const dirty = "https://fityun-mall-cdn.fityun.cn/cloud/teacher/origin/1621577440hx}5rio7.png";
  const fixed = pickImageUrl(dirty);
  check("花括号被转义", fixed && fixed.indexOf("}") < 0 && fixed.indexOf("%7D") > 0, fixed);
  check("转义后仍是同一张图", fixed === dirty.replace("}", "%7D"));

  // ⑤ 签名参数不能被二次编码（这是只替换非法字符、不整体 encodeURI 的原因）
  const signed = "https://x.cn/a.png?sign=a%2Bb%3D&t=1";
  check("已编码的签名参数不动", pickImageUrl(signed) === signed);

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
