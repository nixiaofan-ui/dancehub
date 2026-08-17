<script setup>
import { ref, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { coachApi, studioApi } from "../api/index.js";

const list = ref([]);
const studios = ref([]);
const loading = ref(false);
const studioFilter = ref("");

const dialog = ref(false);
const editing = ref(null);
const form = ref({});
const saving = ref(false);

async function loadStudios() {
  studios.value = await studioApi.list({});
}

async function load() {
  loading.value = true;
  try {
    list.value = await coachApi.list(studioFilter.value || undefined);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = { studioId: studios.value[0]?.id, name: "", avatarUrl: "" };
  dialog.value = true;
}

function openEdit(row) {
  editing.value = row;
  form.value = { studioId: row.studioId, name: row.name, avatarUrl: row.avatarUrl || "" };
  dialog.value = true;
}

async function save() {
  if (!form.value.name || !form.value.studioId) {
    ElMessage.warning("所属舞室与教练名必填");
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await coachApi.update(editing.value.id, form.value);
      ElMessage.success("更新成功");
    } else {
      await coachApi.create(form.value);
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
  await ElMessageBox.confirm(`确认删除教练「${row.name}」？`, "提示", { type: "warning" });
  await coachApi.remove(row.id);
  ElMessage.success("已删除");
  load();
}

onMounted(async () => {
  await loadStudios();
  load();
});
</script>

<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-select v-model="studioFilter" placeholder="全部舞室" clearable style="width: 220px" @change="load">
          <el-option v-for="s in studios" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-button type="success" @click="openCreate">+ 新增教练</el-button>
      </div>

      <el-table v-loading="loading" :data="list" border stripe>
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="头像" width="70">
          <template #default="{ row }">
            <el-avatar :size="40" :src="row.avatarUrl || undefined">{{ row.name[0] }}</el-avatar>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="教练名" min-width="140" />
        <el-table-column label="所属舞室" min-width="160">
          <template #default="{ row }">{{ row.studio?.name }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialog" :title="editing ? '编辑教练' : '新增教练'" width="440px">
      <el-form label-width="90px">
        <el-form-item label="所属舞室" required>
          <el-select v-model="form.studioId" style="width: 100%">
            <el-option v-for="s in studios" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="教练名" required>
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="头像 URL">
          <el-input v-model="form.avatarUrl" placeholder="https://... (可选)" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
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
</style>