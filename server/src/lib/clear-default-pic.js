/**
 * 清掉「平台默认背景图」当课程封面的历史数据。
 *
 * 为什么需要它：iWOD 商家没传封面时，课表接口不是给空串，而是回落到**平台内置的
 * 通用课程底图**（`https://cdn.iwod.cn/lessonbgfour.png` / `lessonbgtwo.png` …）。
 * 抓取侧（engine.js 的 IWOD_DEFAULT_BG_RE）已经过滤掉新数据了，但**存量**改不动：
 * `importer.keepOldOnMissing` 会保护 coursePicUrl，上游这次没给就保留旧值 ——
 * 于是那批通用底图会永远挂在课详情页的「课程预告图」上，每节课长得都一样，
 * 用户会当成「这门课的照片」。
 *
 * ⛔ 只认 iWOD 这一套 `lessonbg*` 命名，别扩大到所有「看起来像默认图」的 URL：
 *    菲体云也有自己的默认头像（default/customer/default.png），那是另一套规则，
 *    混在一起清会误伤真实封面。
 *
 * 幂等：清完第二次必然 0 行（因为已经置 null 了）。
 */
import { prisma } from "./prisma.js";

/** iWOD 平台默认课程底图的 URL 特征（与 engine.js 同源，两边必须一致） */
const DEFAULT_BG_MARK = "lessonbg";

let done = false;

/**
 * @param {(msg:string)=>void} log
 * @returns {Promise<number>} 清理掉的行数
 */
export async function clearDefaultCoursePic({ log = () => {} } = {}) {
  if (done) return 0;
  done = true;
  try {
    const { count } = await prisma.schedule.updateMany({
      where: { coursePicUrl: { contains: DEFAULT_BG_MARK } },
      data: { coursePicUrl: null },
    });
    if (count > 0) log(`[clear-default-pic] 清掉 ${count} 条平台默认课程底图（iWOD lessonbg*）`);
    return count;
  } catch (err) {
    // 清理失败不该挡住启动：脏封面只是难看，不影响约课
    console.warn(`[clear-default-pic] 清理失败：${err.message}`);
    return 0;
  }
}
