#!/usr/bin/env bash
#
# 把本机 MySQL 的 dancehub 库同步到微信云托管的云 MySQL（CynosDB 5.7）。
#
# 为什么要手工同步：
#   云托管服务 MinNum=0（Serverless 无请求时缩容到 0），定时抓取根本跑不起来，
#   所以云端设了 SKIP_CRAWLER=1 只做 API。数据在本机抓完后，用本脚本推上云。
#
# 用法：
#   set -a; source server/.env; set +a      # 读取下面这些变量
#   bash server/scripts/sync_cloud_db.sh
#
# 需要的环境变量（不要写死在脚本里，避免密钥进版本库）：
#   LOCAL_MYSQL_CONTAINER  本机 MySQL 容器名      默认 dancehub-mysql
#   LOCAL_MYSQL_PWD        本机 root 密码
#   CLOUD_DB_HOST          云库公网地址
#   CLOUD_DB_PORT          云库公网端口          默认 27888
#   CLOUD_DB_USER          云库账号              默认 root
#   CLOUD_DB_PWD           云库密码
#   CLOUD_DB_NAME          库名                  默认 dancehub
#
# ⚠ 云库公网地址需在控制台临时打开，用完建议关闭（公网入口长期暴露有风险）。

set -euo pipefail

LOCAL_CONTAINER="${LOCAL_MYSQL_CONTAINER:-dancehub-mysql}"
LOCAL_PWD="${LOCAL_MYSQL_PWD:?缺少 LOCAL_MYSQL_PWD}"
CLOUD_HOST="${CLOUD_DB_HOST:?缺少 CLOUD_DB_HOST}"
CLOUD_PORT="${CLOUD_DB_PORT:-27888}"
CLOUD_USER="${CLOUD_DB_USER:-root}"
CLOUD_PWD="${CLOUD_DB_PWD:?缺少 CLOUD_DB_PWD}"
CLOUD_DB="${CLOUD_DB_NAME:-dancehub}"

TS=$(date +%Y%m%d-%H%M%S)
DUMP="/tmp/dh_sync_${TS}.sql"
BACKUP="/tmp/dh_cloud_backup_${TS}.sql"

echo "[1/4] 导出本机 ${CLOUD_DB} ..."
docker exec "${LOCAL_CONTAINER}" mysqldump \
  -uroot -p"${LOCAL_PWD}" \
  --single-transaction --skip-lock-tables \
  --default-character-set=utf8mb4 "${CLOUD_DB}" >"${DUMP}"
echo "      $(wc -c <"${DUMP}") 字节"

# 本机若是 MySQL 8.0，dump 里会带 5.7 不认识的 utf8mb4_0900_ai_ci，导入会直接报错
if grep -q "utf8mb4_0900_ai_ci" "${DUMP}"; then
  echo "      发现 8.0 排序规则，替换为 utf8mb4_unicode_ci ..."
  sed -i '' 's/utf8mb4_0900_ai_ci/utf8mb4_unicode_ci/g' "${DUMP}"
fi

echo "[2/4] 备份云库 → ${BACKUP}"
docker exec "${LOCAL_CONTAINER}" mysqldump \
  -h "${CLOUD_HOST}" -P "${CLOUD_PORT}" -u"${CLOUD_USER}" -p"${CLOUD_PWD}" \
  --single-transaction --default-character-set=utf8mb4 "${CLOUD_DB}" >"${BACKUP}" 2>/dev/null
echo "      $(wc -c <"${BACKUP}") 字节"

echo "[3/4] 导入云库 ..."
docker exec -i "${LOCAL_CONTAINER}" mysql \
  -h "${CLOUD_HOST}" -P "${CLOUD_PORT}" -u"${CLOUD_USER}" -p"${CLOUD_PWD}" \
  --default-character-set=utf8mb4 "${CLOUD_DB}" <"${DUMP}" 2>/dev/null

echo "[4/4] 核对"
docker exec "${LOCAL_CONTAINER}" mysql \
  -h "${CLOUD_HOST}" -P "${CLOUD_PORT}" -u"${CLOUD_USER}" -p"${CLOUD_PWD}" \
  --default-character-set=utf8mb4 "${CLOUD_DB}" \
  -e "SELECT (SELECT COUNT(*) FROM Studio) AS studios, (SELECT COUNT(*) FROM Schedule) AS schedules, (SELECT MIN(scheduleDate)) AS min_date, (SELECT MAX(scheduleDate)) AS max_date FROM Schedule;" 2>/dev/null

echo "完成。云库备份在 ${BACKUP}"
