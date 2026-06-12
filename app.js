App({
  onLaunch: function () {
    // 初始化云开发环境
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloud1-d0gcb13bn0c957a47',   
        traceUser: true
      })
    }

    var sysInfo = wx.getSystemInfoSync()
    this.globalData.statusBarHeight = sysInfo.statusBarHeight
    this.globalData.screenWidth = sysInfo.screenWidth
    this.globalData.screenHeight = sysInfo.screenHeight
    this.globalData.pixelRatio = sysInfo.pixelRatio
  },
  globalData: {
    statusBarHeight: 0,
    screenWidth: 375,
    screenHeight: 667,
    pixelRatio: 2
  }
})
