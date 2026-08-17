<script setup>
import { ref, onMounted } from "vue";
import { studioApi, coachApi, scheduleApi, adminApi } from "../api/index.js";

const stats = ref([
  { label: "舞室", value: "-", icon: "OfficeBuilding", color: "#409eff" },
  { label: "教练", value: "-", icon: "Avatar", color: "#67c23a" },
  { label: "今日课程", value: "-", icon: "Calendar", color: "#e6a23c" },
  { label: "预约记录", value: "-", icon: "List", color: "#f56c6c" },
]);

const today = new Date().toISOString().slice(0, 10);

onMounted(async () => {
  const [studios, coaches, schedules, bookings] = await Promise.all([
    studioApi.list({}),
    coachApi.list(),
    scheduleApi.list({ from: today, to: today }),
    adminApi.bookings(),
  ]);
  stats.value = [
    { ...stats.value[0], value: studios.length },
    { ...stats.value[1], value: coaches.length },
    { ...stats.value[2], value: schedules.length },
    { ...stats.value[3], value: bookings.length },
  ];
});
</script>

<template>
  <div>
    <el-row :gutter="16">
      <el-col v-for="s in stats" :key="s.label" :span="6">
        <el-card shadow="hover">
          <div class="stat-item">
            <el-icon :size="34" :color="s.color"><component :is="s.icon" /></el-icon>
            <div>
              <div class="stat-value">{{ s.value }}</div>
              <div class="stat-label">{{ s.label }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
    <el-card class="welcome" shadow="never">
      <p>欢迎使用 DanceHub 管理后台。数据录入流程：<b>舞室 → 教练 → 课程排期</b>（支持「复制上周排期」）。</p>
      <p class="muted">今日课程统计基于 <code>{{ today }}</code>。</p>
    </el-card>
  </div>
</template>

<style scoped>
.stat-item {
  display: flex;
  align-items: center;
  gap: 14px;
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
}
.stat-label {
  color: #909399;
  font-size: 13px;
}
.welcome {
  margin-top: 16px;
}
.welcome p {
  margin: 6px 0;
}
.muted {
  color: #909399;
  font-size: 13px;
}
</style>