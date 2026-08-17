import { createRouter, createWebHashHistory } from "vue-router";
import { auth } from "../stores/auth.js";

const routes = [
  {
    path: "/login",
    component: () => import("../views/Login.vue"),
  },
  {
    path: "/",
    component: () => import("../views/Layout.vue"),
    redirect: "/dashboard",
    children: [
      {
        path: "dashboard",
        component: () => import("../views/Dashboard.vue"),
        meta: { title: "概览" },
      },
      {
        path: "studios",
        component: () => import("../views/StudioList.vue"),
        meta: { title: "舞室管理" },
      },
      {
        path: "coaches",
        component: () => import("../views/CoachList.vue"),
        meta: { title: "教练管理" },
      },
      {
        path: "schedules",
        component: () => import("../views/ScheduleList.vue"),
        meta: { title: "课程排期" },
      },
      {
        path: "bookings",
        component: () => import("../views/BookingList.vue"),
        meta: { title: "预约记录" },
      },
    ],
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  if (to.path !== "/login" && !auth.token) return "/login";
  if (to.path === "/login" && auth.token) return "/";
  return true;
});

export default router;