/**
 * 把 server 代码里所有 `lib/prisma.js` 的导入重定向到内存桩，
 * 让烟测不连 MySQL 就能跑 importer / dedupe 的真实逻辑。
 * 用法（在烟测入口，且必须先于任何 server 模块的 import）：
 *   import { register } from "node:module";
 *   register("./prisma-stub-hooks.mjs", import.meta.url);
 */
import { pathToFileURL } from "node:url";

const STUB = pathToFileURL(
  new URL("./testing/fake-prisma-stub.mjs", import.meta.url).pathname,
).href;

export async function resolve(specifier, context, next) {
  if (
    specifier.endsWith("lib/prisma.js") ||
    specifier === "./prisma.js" ||
    specifier === "../lib/prisma.js"
  ) {
    return { url: STUB, shortCircuit: true };
  }
  return next(specifier, context);
}
