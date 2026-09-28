const app = getApp();
const api = require("../../services/api");
const { toast } = require("../../utils/toast");

Page({
  data: {
    name: "",
    city: "",
    comment: "",
    contact: "",
    submitting: false,
  },

  onLoad() {
    const g = app.globalData;
    const city = (g.cities || []).find((c) => c.id === g.cityId);
    this.setData({ city: city ? city.name : "" });
  },

  onName(e) {
    this.setData({ name: e.detail.value });
  },
  onCity(e) {
    this.setData({ city: e.detail.value });
  },
  onComment(e) {
    this.setData({ comment: e.detail.value });
  },
  onContact(e) {
    this.setData({ contact: e.detail.value });
  },

  async submit() {
    const name = (this.data.name || "").trim();
    if (!name) return toast(this, "先填舞室名称");
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    try {
      await api.ensureReady();
      await api.apiSubmitReport({
        name,
        city: (this.data.city || "").trim(),
        comment: (this.data.comment || "").trim(),
        contact: (this.data.contact || "").trim(),
      });
      toast(this, "收到啦，我们会尽快补上", "success");
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (e) {
      toast(this, e.message);
      this.setData({ submitting: false });
    }
  },
});
