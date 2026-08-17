<script setup>
import { ref, onMounted } from "vue";
import { adminApi, common } from "../api/index.js";

const list = ref([]);
const loading = ref(false);
const dateFilter = ref("");

async function load() {
  loading.value = true;
  try {
    list.value = await adminApi.bookings(dateFilter.value || undefined);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-date-picker
          v-model="dateFilter"
          type="date"
          placeholder="按课程日期筛选"
          value-format="YYYY-MM-DD"
          clearable
          style="width: 180px"
          @change="load"
        />
        <span class="count">共 {{ list.length }} 条记录（只读）</span>
      </div>

      <el-table v-loading="loading" :data="list" border stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="用户" width="140">
          <template #default="{ row }">{{ row.user.nickname || row.user.openid }}</template>
        </el-table-column>
        <el-table-column label="课程" min-width="140">
          <template #default="{ row }">{{ row.schedule.courseName }}</template>
        </el-table-column>
        <el-table-column label="舞室" min-width="130">
          <template #default="{ row }">{{ row.schedule.studio }}</template>
        </el-table-column>
        <el-table-column label="城市" width="90">
          <template #default="{ row }">{{ row.schedule.city }}</template>
        </el-table-column>
        <el-table-column label="日期" width="110">
          <template #default="{ row }">{{ row.schedule.scheduleDate }}</template>
        </el-table-column>
        <el-table-column label="时间" width="110">
          <template #default="{ row }">{{ row.schedule.startTime }} - {{ row.schedule.endTime }}</template>
        </el-table-column>
        <el-table-column label="教练" width="90">
          <template #default="{ row }">{{ row.schedule.coach || "-" }}</template>
        </el-table-column>
        <el-table-column label="方式" width="80">
          <template #default="{ row }">{{ common.bookingMethodLabel[row.method] }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'CONFIRMED' ? 'success' : 'warning'">
              {{ common.bookingStatusLabel[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="标记时间" width="160">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.count {
  color: #909399;
  font-size: 13px;
}
</style>