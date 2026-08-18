Component({
  data: {
    visible: false,
    text: "",
    type: "info",
    timer: null,
  },

  methods: {
    show(text, type = "info") {
      clearTimeout(this.data.timer);
      this.setData({ visible: true, text, type });
      const timer = setTimeout(() => {
        this.setData({ visible: false });
      }, 3000);
      this.setData({ timer });
    },
  },
});