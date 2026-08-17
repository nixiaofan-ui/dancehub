<script setup>
import { ref, watch, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { scheduleApi, studioApi, coachApi, common } from "../api/index.js";

const list = ref([]);
const studios = ref([]);
const coaches = ref([]);
const loading = ref(false);

const today = new Date().toISOString().slice(0, 10);
const query = ref({ studioId: "", from: "", to: "" });

const dialog = ref(false);
const editing = ref(null);
const form = ref({});
const saving = ref(false);

const copyDialog = ref(false);
const copyRange = ref({ start: today, end: today });
const copying = ref(false);

const difficultyOptions = Object.entries(common.difficultyLabel).map(([value, label]) => ({ value, label }));

async function loadStudios() {
  studios.value = await studioApi.list({});
}

async function loadCoaches(studioId) {
  coaches.value = studioId ? await coachApi.list(studioId) : [];
}

async function load() {
  loading.value = true;
  try {
    const params = {};
    if (query.value.studioId) params.studioId = query.value.studioId;
    if (query.value.from) params.from = query.value.from;
    if (query.value.to) params.to = query.value.to;
    list.value = await scheduleApi.list(params);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = {
    studioId: studios.value[0]?.id,
    coachId: null,
    courseName: "",
    difficulty: "ALL_LEVELS",
    scheduleDate: today,
    startTime: "18:00",
    endTime: "19:00",
    bookingUrl: "",
    remark: "",
  };
  loadCoaches(form.value.studioId);
  dialog.value = true;
}

function openEdit(row) {
  editing.value = row;
  form.value = {
    studioId: row.studioId,
    coachId: row.coach ? row.coach.id : null,
    courseName: row.courseName,
    difficulty: row.difficulty,
    scheduleDate: row.scheduleDate,
    startTime: row.startTime,
    endTime: row.endTime,
    bookingUrl: row.bookingUrl || "",
    remark: row.remark || "",
  };
  loadCoaches(row.studioId);
  dialog.value = true;
}

async function save() {
  const f = form.value;
  if (!f.studioId || !f.courseName || !f.scheduleDate || !f.startTime || !f.endTime) {
    ElMessage.warning("舞室/课程名/日期/起止时间必填");
    return;
  }
  if (f.startTime >= f.endTime) {
    ElMessage.warning("结束时间必须晚于开始时间");
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await scheduleApi.update(editing.value.id, f);
      ElMessage.success("更新成功");
    } else {
      await scheduleApi.create(f);
      ElMessage.success("创建成功");
    }
    dialog.value = false;
    load();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除排期「${row.courseName} ${row.startTime}」？`, "提示", { type: "warning" });
  await scheduleApi.remove(row.id);
  ElMessage.success("已删除");
  load();
}

async function doCopy() {
  if (!copyRange.value.start || !copyRange.value.end) {
    ElMessage.warning("请选择目标日期范围");
    return;
  }
  if (copyRange.value.start > copyRange.value.end) {
    ElMessage.warning("开始日期不能晚于结束日期");
    return;
  }
  copying.value = true;
  try {
    const result = await scheduleApi.copyPreviousWeek(copyRange.value);
    ElMessage.success(`已复制 ${result.created} 条排期`);
    copyDialog.value = false;
    load();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    copying.value = false;
  }
}

watch(() => form.value.studioId, (id) => {
  if (dialog.value) {
    form.value.coachId = null;
    loadCoaches(id);
  }
});

onMounted(async () => {
  await loadStudios();
  load();
});
</script>

<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-select v-model="query.studioId" placeholder="全部舞室" clearable style="width: 180px">
          <el-option v-for="s in studios" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-date-picker v-model="query.from" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" style="width: 150px" />
        <el-date-picker v-model="query.to" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" style="width: 150px" />
        <el-button type="primary" @click="load">查询</el-button>
        <div class="spacer" />
        <el-button type="warning" @click="copyDialog = true">复制上周排期</el-button>
        <el-button type="success" @click="openCreate">+ 新增排期</el-button>
      </div>

      <el-table v-loading="loading" :data="list" border stripe>
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column prop="scheduleDate" label="日期" width="110" />
        <el-table-column label="时间" width="110">
          <template #default="{ row }">{{ row.startTime }} - {{ row.endTime }}</template>
        </el-table-column>
        <el-table-column label="舞室" min-width="130">
          <template #default="{ row }">{{ row.studio.name }}</template>
        </el-table-column>
        <el-table-column prop="courseName" label="课程名" min-width="130" />
        <el-table-column label="教练" width="100">
          <template #default="{ row }">{{ row.coach?.name || "-" }}</template>
        </el-table-column>
        <el-table-column label="难度" width="80">
          <template #default="{ row }">
            <el-tag size="small">{{ common.difficultyLabel[row.difficulty] || row.difficulty }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="bookingUrl" label="预约链接" min-width="160" show-overflow-tooltip />
        <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialog" :title="editing ? '编辑排期' : '新增排期'" width="560px">
      <el-form label-width="90px">
        <el-form-item label="舞室" required>
          <el-select v-model="form.studioId" style="width: 100%">
            <el-option v-for="s in studios" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="教练">
          <el-select v-model="form.coachId" clearable placeholder="可选" style="width: 100%">
            <el-option v-for="c in coaches" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="课程名" required>
          <el-input v-model="form.courseName" />
        </el-form-item>
        <el-form-item label="难度">
          <el-select v-model="form.difficulty" style="width: 100%">
            <el-option v-for="o in difficultyOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期" required>
          <el-date-picker v-model="form.scheduleDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="起止时间" required>
          <el-time-picker v-model="form.startTime" value-format="HH:mm" placeholder="开始" style="width: 45%" />
          <span style="margin: 0 6px">至</span>
          <el-time-picker v-model="form.endTime" value-format="HH:mm" placeholder="结束" style="width: 45%" />
        </el-form-item>
        <el-form-item label="预约链接">
          <el-input v-model="form.bookingUrl" placeholder="https://... 或复制搜索词" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="copyDialog" title="复制上周排期" width="440px">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
        将「所选日期 -7 天」的排期复制到所选日期。已存在的相同课程（同舞室同课程同日）会自动跳过。
      </el-alert>
      <el-form label-width="90px">
        <el-form-item label="目标日期" required>
          <el-date-picker v-model="copyRange.start" type="date" value-format="YYYY-MM-DD" placeholder="开始" style="width: 45%" />
          <span style="margin: 0 6px">至</span>
          <el-date-picker v-model="copyRange.end" type="date" value-format="YYYY-MM-DD" placeholder="结束" style="width: 45%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="copyDialog = false">取消</el-button>
        <el-button type="warning" :loading="copying" @click="doCopy">开始复制</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.spacer {
  flex: 1;
}
</style>