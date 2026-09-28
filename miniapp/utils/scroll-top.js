/**
 * 双击导航栏顶部 → 回到页面顶部。
 *
 * iOS 有系统级手势（双击状态栏回顶），安卓没有对应操作，
 * 所以用自定义导航条的页面必须自己补一个，否则安卓用户滑到底只能手动往上扒。
 *
 * 当前所有页面都是页面级纵向滚动（横滑的门店/城市条是 scroll-x），
 * 因此统一走 wx.pageScrollTo。将来某页改成 scroll-y 的 scroll-view 时，
 * 需要额外把该 scroll-view 的 scrollTop 置 0（并注意值相同不会触发滚动，
 * 要先置一个非零值再回 0）。
 */
function onNavTop() {
  wx.pageScrollTo({ scrollTop: 0, duration: 260 });
}

module.exports = { onNavTop };
