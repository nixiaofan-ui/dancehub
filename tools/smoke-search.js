/**
 * 门店搜索回归（跑本地库，不需要起服务）
 *   /usr/local/bin/node tools/smoke-search.js
 *
 * 为什么要这份测试：「北京 T-rex 搜 trex 搜不到，必须打连字符」这个 bug
 * 反复出现过两次 —— 一次是索引侧的归一化还没做，一次是查询侧的归一化
 * 和被查询的索引串用了两套不同的算法。两边的归一化只要差一点，
 * `trex` 就永远匹配不上 `trexdance`，而接口照样返回 200 空列表，看不出来。
 *
 * 所以下面每条断言盯的都是「用户实际会怎么打」，不是实现细节。
 */
const path = require("path");

require(path.join(__dirname, "../server/node_modules/dotenv")).config({
  path: path.join(__dirname, "../server/.env"),
});

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const okv = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${okv ? "  ok  " : " FAIL "} ${label}${okv ? "" : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`}`);
  okv ? pass++ : fail++;
}

// 本地库里这家店就是生产上那家：id 1142 / 北京 / 名字写作「t-rex dance」
const TREX_ID = 1142;
const BEIJING = 14;

(async () => {
  const { normName, searchStudioIdsByNorm } = await import(
    path.join(__dirname, "../server/src/lib/studio-index.js")
  );

  console.log("\n[1] 归一化：连字符/空格/大小写都必须被抹平");
  check("t-rex dance → trexdance", normName("t-rex dance"), "trexdance");
  check("T REX → trex", normName("T REX"), "trex");
  check("T-REX → trex", normName("T-REX"), "trex");
  check("Golden belt 街舞厂牌 → goldenbelt街舞厂牌", normName("Golden belt 街舞厂牌"), "goldenbelt街舞厂牌");
  check("全角空格也抹掉", normName("t　rex"), "trex");
  check("空值安全", normName(null), "");

  console.log("\n[2] 用户可能打出的每种写法都要搜到那家 T-rex");
  for (const kw of ["trex", "t-rex", "t rex", "TREX", "T-Rex", "trexdance", "trex dance"]) {
    const ids = await searchStudioIdsByNorm(kw, { cityId: BEIJING, onlyActive: true });
    check(`北京搜「${kw}」能出 t-rex`, ids.includes(TREX_ID), true);
  }

  console.log("\n[3] 相关度排序：前缀命中要压过包含命中");
  {
    const ids = await searchStudioIdsByNorm("trex", { cityId: BEIJING, onlyActive: true });
    check("命中的第一条就是 t-rex", ids[0], TREX_ID);
  }

  console.log("\n[4] 边界：太短的 needle 不能反查半个库，无关的不能硬凑");
  check("单字不搜", (await searchStudioIdsByNorm("舞", { cityId: BEIJING })).length, 0);
  check("空串不搜", (await searchStudioIdsByNorm("", { cityId: BEIJING })).length, 0);
  {
    const ids = await searchStudioIdsByNorm("zzzzzzz", { cityId: BEIJING, onlyActive: true });
    check("无关关键词 0 结果", ids.length, 0);
  }

  console.log("\n[5] 城市限定必须生效（否则北京店会串到杭州的结果里）");
  {
    const ids = await searchStudioIdsByNorm("trex", { cityId: 13, onlyActive: true });
    check("杭州搜 trex 无命中", ids.includes(TREX_ID), false);
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("测试崩了：", e.message);
  process.exit(1);
});
