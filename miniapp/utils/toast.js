/**
 * 自定义 Toast：通过页面上的 <toast id="toast" /> 组件展示
 * 用法：toast(this, "文案") / toast(this, "文案", "success" | "error")
 * 若页面未挂载 toast 组件则回退到原生 wx.showToast
 */
function toast(page, text, type) {
  if (!page) {
    wx.showToast({ title: text, icon: "none" });
    return;
  }
  const inst = page.selectComponent && page.selectComponent("#toast");
  if (inst && typeof inst.show === "function") {
    inst.show(text, type);
  } else {
    wx.showToast({ title: text, icon: type === "success" ? "success" : "none" });
  }
}

module.exports = { toast };