/**
 * 抓取引擎
 * - automator 模式：通过 miniprogram-automator 启动微信开发者工具，
 *   打开目标小程序 → 跳转课表页 → 按配置的 CSS 选择器抽取课程卡片数据。
 * - mock 模式：返回演示数据（结构与真实卡片一致），便于无开发者工具环境联调。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 演示数据：对齐 MAX POWER 课程卡片（课程名/时间/教练/状态/容量） */
function mockRaw() {
  return [
    {
      courseName: "JAZZ FUNK 初级",
      coach: "Vivi",
      time: "19:30-20:30",
      capacity: "8/20",
      status: "预约中",
    },
    {
      courseName: "HIPHOP 中级",
      coach: "Kai",
      time: "20:40-21:40",
      capacity: "已满",
      status: "约满",
    },
    {
      courseName: "WAACKING 入门",
      coach: "Luna",
      time: "18:00-19:00",
      capacity: "3/20",
      status: "预约中",
    },
    {
      courseName: "LOCKING 高级",
      coach: "Jay",
      time: "18:00-19:00",
      capacity: "0/16",
      status: "已开场",
    },
  ];
}

/** 自动化抓取（需要本机微信开发者工具 + 目标小程序项目） */
async function crawlWithAutomator(config) {
  let automator;
  try {
    automator = await import("miniprogram-automator");
  } catch (e) {
    throw new Error(
      `未安装 miniprogram-automator，请先在 server/ 下执行 npm install。(${e.message})`,
    );
  }

  const { launch } = automator.default || automator;
  let miniProgram;
  try {
    miniProgram = await launch({
      cliPath: config.cliPath,
      projectPath: config.projectPath,
      port: config.automatorPort || 9420,
    });
  } catch (e) {
    throw new Error(
      `无法启动微信开发者工具，请确认已安装并开启「服务端口」。(${e.message})`,
    );
  }

  try {
    await miniProgram.reLaunch(`/${config.schedulePagePath}`);
    await sleep(config.pageLoadDelay || 800);

    const page = await miniProgram.currentPage();
    await page.waitFor(config.selectors.list, 10000);

    const cards = await page.$$(config.selectors.list);
    const raw = [];
    for (const card of cards) {
      const read = async (sel) => {
        if (!sel) return "";
        const node = await card.$(sel);
        if (!node) return "";
        return ((await node.text()) || "").trim();
      };
      raw.push({
        courseName: await read(config.selectors.courseName),
        coach: await read(config.selectors.coach),
        time: await read(config.selectors.time),
        capacity: await read(config.selectors.capacity),
        status: await read(config.selectors.status),
      });
    }
    return raw.filter((r) => r.courseName);
  } finally {
    await miniProgram.close().catch(() => {});
  }
}

/** 统一入口：返回原始条目数组 [{ courseName, coach, time, capacity, status }] */
export async function crawl(config) {
  if (!config) throw new Error("缺少抓取配置");
  if (config.mode === "mock") return mockRaw();
  if (config.mode === "automator") return crawlWithAutomator(config);
  throw new Error(`未知抓取模式: ${config.mode}`);
}
