<script setup>
import { ref, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { studioApi, cityApi, common } from "../api/index.js";

const list = ref([]);
const cities = ref([]);
const loading = ref(false);

const query = ref({ cityId: "", keyword: "" });

const dialog = ref(false);
const editing = ref(null);
const form = ref({});
const saving = ref(false);

const platformOptions = Object.entries(common.platformLabel).map(([value, label]) => ({ value, label }));

async function loadCities() {
  cities.value = await cityApi.list();
}

async function load() {
  loading.value = true;
  try {
    const params = {};
    if (query.value.cityId) params.cityId = query.value.cityId;
    if (query.value.keyword) params.keyword = query.value.keyword;
    list.value = await studioApi.list(params);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = {
    cityId: cities.value[0]?.id,
    name: "",
    address: "",
    contact: "",
    logoUrl: "",
    platform: "WECHAT",
    status: true,
  };
  dialog.value = true;
}

function openEdit(row) {
  editing.value = row;
  form.value = {
    cityId: row.cityId,
    name: row.name,
    address: row.address || "",
    contact: row.contact || "",
    logoUrl: row.logoUrl || "",
    platform: row.platform,
    status: row.status,
  };
  dialog.value = true;
}

async function save() {
  if (!form.value.name || !form.value.cityId) {
    ElMessage.warning("城市与舞室名必填");
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await studioApi.update(editing.value.id, form.value);
      ElMessage.success("更新成功");
    } else {
      await studioApi.create(form.value);
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
  await ElMessageBox.confirm(`确认停用「${row.name}」？`, "提示", { type: "warning" });
  await studioApi.remove(row.id);
  ElMessage.success("已停用");
  load();
}

onMounted(async () => {
  await loadCities();
  load();
});
</script>

<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-select v-model="query.cityId" placeholder="全部城市" clearable style="width: 140px" @change="load">
          <el-option v-for="c in cities" :key="c.id" :label="c.name" :value="c.id">
            <span>{{ c.name }}</span>
            <span class="region-tag">{{ c.region === "CN" ? "国内" : "海外" }}</span>
          </el-option>
        </el-select>
        <el-input v-model="query.keyword" placeholder="按名称/地址搜索" clearable style="width: 220px" @keyup.enter="load" @clear="load" />
        <el-button type="primary" @click="load">查询</el-button>
        <el-button type="success" @click="openCreate">+ 新增舞室</el-button>
      </div>

      <el-table v-loading="loading" :data="list" border stripe>
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="Logo" width="70">
          <template #default="{ row }">
            <el-avatar :size="40" :src="row.logoUrl || undefined">{{ row.name[0] }}</el-avatar>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="舞室名" min-width="140" />
        <el-table-column label="城市" width="90">
          <template #default="{ row }">{{ row.city?.name }}<span class="region-tag">{{ row.city?.region === "CN" ? "国内" : "海外" }}</span></template>
        </el-table-column>
        <el-table-column prop="address" label="地址" min-width="180" show-overflow-tooltip />
        <el-table-column prop="contact" label="联系方式" width="130" />
        <el-table-column label="平台" width="110">
          <template #default="{ row }">{{ common.platformLabel[row.platform] || row.platform }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.status ? 'success' : 'info'">{{ row.status ? "启用" : "停用" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" :disabled="!row.status" @click="remove(row)">停用</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialog" :title="editing ? '编辑舞室' : '新增舞室'" width="480px">
      <el-form label-width="90px">
        <el-form-item label="城市" required>
          <el-select v-model="form.cityId" style="width: 100%">
            <el-option v-for="c in cities" :key="c.id" :label="`${c.name} (${c.region === 'CN' ? '国内' : '海外'})`" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="舞室名" required>
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.address" />
        </el-form-item>
        <el-form-item label="联系方式">
          <el-input v-model="form.contact" />
        </el-form-item>
        <el-form-item label="Logo URL">
          <el-input v-model="form.logoUrl" placeholder="https://..." />
        </el-form-item>
        <el-form-item label="原平台">
          <el-select v-model="form.platform" style="width: 100%">
            <el-option v-for="o in platformOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.status" />
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
.region-tag {
  float: right;
  color: #909399;
  font-size: 12px;
}
</style>