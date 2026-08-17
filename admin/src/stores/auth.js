export const auth = {
  get token() {
    return localStorage.getItem("admin_token");
  },
  setToken(token) {
    localStorage.setItem("admin_token", token);
  },
  logout() {
    localStorage.removeItem("admin_token");
  },
};