<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import http from "../api/http.js";
import { auth } from "../stores/auth.js";

const router = useRouter();
const token = ref("");
const loading = ref(false);

async function login() {
  const t = token.value.trim();
  if (!t) {
    ElMessage.warning("请输入管理令牌");
    return;
  }
  loading.value = true;
  try {
    await http.get("/admin/check", { headers: { "x-admin-token": t } });
    auth.setToken(t);
    ElMessage.success("登录成功");
    router.push("/");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <div class="login-title">DanceHub 管理后台</div>
      <el-input
        v-model="token"
        type="password"
        placeholder="输入管理令牌"
        show-password
        size="large"
        @keyup.enter="login"
      />
      <el-button type="primary" size="large" class="login-btn" :loading="loading" @click="login">
        登录
      </el-button>
      <div class="login-hint">本地开发默认令牌：admin123</div>
    </el-card>
  </div>
</template>

<style scoped>
.login-wrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1f2a44 0%, #3a4a6b 100%);
}
.login-card {
  width: 380px;
  padding: 12px;
}
.login-title {
  text-align: center;
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 24px;
}
.login-btn {
  width: 100%;
  margin-top: 16px;
}
.login-hint {
  margin-top: 14px;
  text-align: center;
  color: #909399;
  font-size: 12px;
}
</style>