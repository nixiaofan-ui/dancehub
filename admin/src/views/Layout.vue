<script setup>
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { auth } from "../stores/auth.js";

const route = useRoute();
const router = useRouter();

const menus = [
  { path: "/dashboard", title: "概览", icon: "Odometer" },
  { path: "/studios", title: "舞室管理", icon: "OfficeBuilding" },
  { path: "/coaches", title: "教练管理", icon: "Avatar" },
  { path: "/schedules", title: "课程排期", icon: "Calendar" },
  { path: "/bookings", title: "预约记录", icon: "List" },
];

async function logout() {
  await ElMessageBox.confirm("确认退出登录？", "提示", { type: "warning" });
  auth.logout();
  router.push("/login");
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="200px" class="aside">
      <div class="logo">DanceHub Admin</div>
      <el-menu :default-active="route.path" router background-color="#1f2a44" text-color="#c0c4cc" active-text-color="#409eff">
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          <el-icon><component :is="m.icon" /></el-icon>
          <span>{{ m.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ route.meta.title }}</span>
        <el-button link type="primary" @click="logout">退出登录</el-button>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}
.aside {
  background: #1f2a44;
}
.logo {
  height: 56px;
  line-height: 56px;
  text-align: center;
  color: #fff;
  font-weight: 700;
  letter-spacing: 1px;
}
.aside :deep(.el-menu) {
  border-right: none;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #ebeef5;
}
.page-title {
  font-size: 16px;
  font-weight: 600;
}
</style>