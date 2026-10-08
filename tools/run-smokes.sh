#!/usr/bin/env bash
# 跑全部烟测。提交前过一遍，别靠记忆逐个敲。
#
#   npm run smoke                 # 从仓库根跑
#   NODE=/usr/local/bin/node npm run smoke
#
# 为什么需要它：tools/ 下有 20+ 个 smoke，用法各不相同（CJS / ESM / 要不要 prisma 桩）。
# 2026-10-08 就是靠逐个手跑才发现 `pruneVanished` 那条路径**从来没被任何烟测覆盖**
# —— 桩不支持它的 where 子句，测试却一路绿灯。
#
# 约定：
#   - tools/smoke-*.js / *.mjs  都是自包含入口，直接 node 跑即可（ESM 自己 register 桩）
#   - 退出码非 0 = 失败；脚本最后汇总
set -u

cd "$(dirname "$0")/.." || exit 1
NODE="${NODE:-node}"
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "找不到 node：$NODE（可用 NODE=/path/to/node 指定）"
  exit 1
fi

pass=0
fail=0
failed_names=()

# 稳定顺序，输出可 diff
for f in $(ls tools/smoke-*.js tools/smoke-*.mjs 2>/dev/null | sort); do
  # sm<name> 必须能独立跑；用 server/ 当工作目录，脚本里写的是相对 ../server 的路径
  out=$(cd server && "$NODE" "../$f" 2>&1)
  code=$?
  if [ $code -eq 0 ]; then
    pass=$((pass + 1))
    printf '✔ %s\n' "$f"
  else
    fail=$((fail + 1))
    failed_names+=("$f")
    printf '✖ %s  (exit %d)\n' "$f" "$code"
    # 只打最后几行：失败信息都在尾部，前面是正常的 ✔ 刷屏
    printf '%s\n' "$out" | grep -E '✖|Error|error:|未通过' | head -12 | sed 's/^/    /'
  fi
done

echo
if [ $fail -eq 0 ]; then
  echo "✔ 全部通过（$pass 个文件）"
  exit 0
fi
echo "✖ $fail 个文件未通过（$pass 个通过）："
for n in "${failed_names[@]}"; do echo "    $n"; done
exit 1
