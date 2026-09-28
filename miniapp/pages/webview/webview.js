const { onNavTop } = require("../../utils/scroll-top");
Page({
  onNavTop,

  data: {
    url: "",
  },

  onLoad(options) {
    const url = options.url ? decodeURIComponent(options.url) : "";
    this.setData({ url });
  },
});