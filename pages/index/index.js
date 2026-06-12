// pages/index/index.js
var markdownUtil = require('../../utils/markdown')
var parseMarkdown = markdownUtil.parseMarkdown

// 生成供 wx:for 使用的行号数组
function makeLineArray(count) {
  count = Math.max(count, 6)
  var arr = []
  for (var i = 1; i <= count; i++) {
    arr.push(i)
  }
  return arr
}

Page({
  data: {
    // 当前激活标签 0=课堂助手 1=代码极客
    activeTab: 0,

    // ===== 课堂助手数据 =====
    classroom: {
      imagePath: '',     // 临时路径，用于预览
      fileID: '',        // 云存储 fileID，传给云函数
      uploading: false,  // 是否正在上传到云存储
      loading: false,    // 是否正在调用云函数
      result: '',
      resultNodes: []
    },

    // ===== 代码极客数据 =====
    codegeek: {
      errorText: '',
      loading: false,
      result: null,
      detailNodes: [],
      copied: false,
      lineNumbers: makeLineArray(6)
    },

    // ===== 历史记录数据 =====
    history: {
      items: [],
      loading: false,
      loadingMore: false,
      hasMore: true,
      page: 1,
      total: 0,
      expandedId: null
    }
  },

  // ==================== 标签切换 ====================
  switchTab: function (e) {
    var index = Number(e.currentTarget.dataset.index)
    if (this.data.activeTab === index) return
    this.setData({ activeTab: index })
    // 切到历史 tab 时自动加载第一页
    if (index === 2 && this.data.history.items.length === 0) {
      this.loadHistory(1)
    }
  },

  // ==================== 课堂助手：拍照 / 选择图片 ====================
  handleUpload: function () {
    var that = this
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: function (res) {
        // wx.chooseMedia 的 sourceType：['camera'] 或 ['album']
        var sourceType = res.tapIndex === 0 ? ['camera'] : ['album']
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: sourceType,
          sizeType: ['compressed'],
          success: function (result) {
            var tempFilePath = result.tempFiles[0].tempFilePath
            // 先展示本地预览
            that.setData({
              'classroom.imagePath': tempFilePath,
              'classroom.fileID': '',
              'classroom.result': '',
              'classroom.resultNodes': [],
              'classroom.uploading': true
            })

            // 上传到微信云存储
            wx.showLoading({ title: '上传中…' })
            wx.cloud.uploadFile({
              cloudPath: 'classroom/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.jpg',
              filePath: tempFilePath,
              success: function (uploadRes) {
                wx.hideLoading()
                that.setData({
                  'classroom.fileID': uploadRes.fileID,
                  'classroom.uploading': false
                })
                wx.showToast({ title: '上传成功', icon: 'success', duration: 1500 })
              },
              fail: function (err) {
                wx.hideLoading()
                that.setData({ 'classroom.uploading': false })
                console.error('云存储上传失败:', err)
                wx.showToast({ title: '上传失败，请重试', icon: 'none' })
              }
            })
          },
          fail: function (err) {
            if (err.errMsg.indexOf('cancel') === -1) {
              console.error('[chooseMedia] 失败:', JSON.stringify(err)); wx.showToast({ title: '选图失败: ' + (err.errMsg || '未知'), icon: 'none', duration: 3000 })
            }
          }
        })
      }
    })
  },

  // 清除图片
  handleClearImage: function () {
    var that = this
    wx.showModal({
      title: '确认清除',
      content: '确定要清除当前图片吗？',
      success: function (res) {
        if (res.confirm) {
          that.setData({
            'classroom.imagePath': '',
            'classroom.fileID': '',
            'classroom.result': '',
            'classroom.resultNodes': []
          })
        }
      }
    })
  },

  // ==================== 课堂助手：调用云函数生成摘要 ====================
  handleGenerate: function () {
    var that = this
    var fileID = this.data.classroom.fileID

    if (!fileID) {
      wx.showToast({ title: '请先上传图片', icon: 'none' })
      return
    }

    // 显示 Loading
    this.setData({ 'classroom.loading': true })

    // 客户端超时保护：55s 后强制解除 loading（云函数 config timeout=60s）
    var clientTimeout = setTimeout(function () {
      if (that.data.classroom.loading) {
        that.setData({ 'classroom.loading': false })
        console.error('[客户端超时] analyzeImage 云函数 55s 无响应，强制解除 Loading')
        wx.showToast({ title: '请求超时，请重试', icon: 'none' })
      }
    }, 55000)

    var callCompleted = false
    function handleComplete() {
      if (callCompleted) return
      callCompleted = true
      clearTimeout(clientTimeout)
      that.setData({ 'classroom.loading': false })
    }

    wx.cloud.callFunction({
      name: 'analyzeImage',
      data: {
        fileID: fileID
      },
      success: function (res) {
        handleComplete()

        // 云函数返回结构: res.result
        var cloudResult = res.result
        if (cloudResult && cloudResult.summary) {
          // 将 Markdown 摘要解析为 rich-text nodes
          var resultNodes = parseMarkdown(cloudResult.summary)
          that.setData({
            'classroom.result': cloudResult.summary,
            'classroom.resultNodes': resultNodes
          })
          wx.showToast({ title: '摘要已生成', icon: 'success', duration: 1500 })
        } else if (cloudResult && cloudResult.error) {
          wx.showToast({ title: cloudResult.error, icon: 'none' })
        } else {
          wx.showToast({ title: 'AI 未返回有效结果', icon: 'none' })
        }
      },
      fail: function (err) {
        handleComplete()
        console.error('云函数调用失败:', err)
        wx.showToast({ title: '请求失败，请检查网络', icon: 'none' })
      }
    })
  },

  // ==================== 代码极客：输入处理 ====================
  handleErrorInput: function (e) {
    var value = e.detail.value
    var lineCount = value.split('\n').length
    this.setData({
      'codegeek.errorText': value,
      'codegeek.lineNumbers': makeLineArray(lineCount)
    })
  },

  // 清空输入
  handleClearInput: function () {
    this.setData({
      'codegeek.errorText': '',
      'codegeek.result': null,
      'codegeek.detailNodes': [],
      'codegeek.lineNumbers': makeLineArray(6)
    })
  },

  // ==================== 代码极客：一键诊断（调用云函数）====================
  handleDiagnose: function () {
    var that = this
    var errorText = this.data.codegeek.errorText

    if (!errorText || !errorText.trim()) {
      wx.showToast({ title: '请先输入报错信息', icon: 'none' })
      return
    }

    // 显示 Loading
    this.setData({ 'codegeek.loading': true })

    // 客户端超时保护：55s 后强制解除 loading（云函数 config timeout=60s）
    var clientTimeout = setTimeout(function () {
      if (that.data.codegeek.loading) {
        that.setData({ 'codegeek.loading': false })
        console.error('[客户端超时] diagnoseError 云函数 55s 无响应，强制解除 Loading')
        wx.showToast({ title: '请求超时，请重试', icon: 'none' })
      }
    }, 55000)

    var callCompleted = false
    function handleComplete() {
      if (callCompleted) return
      callCompleted = true
      clearTimeout(clientTimeout)
      that.setData({ 'codegeek.loading': false })
    }

    wx.cloud.callFunction({
      name: 'diagnoseError',
      data: {
        errorText: errorText
      },
      success: function (res) {
        handleComplete()

        // res.result 是云函数返回的对象
        var cloudResult = res.result

        if (cloudResult && cloudResult.result) {
          var d = cloudResult.result
          // 解析 detail 中的 Markdown
          var detailNodes = parseMarkdown(d.detail || '')

          that.setData({
            'codegeek.result': {
              tags: Array.isArray(d.tags) ? d.tags : [],
              cause: d.cause || '',
              solution: d.solution || '',
              code: d.code || '',
              detail: d.detail || '',
              detailNodes: detailNodes
            },
            'codegeek.detailNodes': detailNodes
          })

          wx.showToast({ title: '诊断完成', icon: 'success', duration: 1500 })
        } else if (cloudResult && cloudResult.error) {
          wx.showToast({ title: cloudResult.error, icon: 'none', duration: 2500 })
        } else {
          wx.showToast({ title: 'AI 未返回有效诊断', icon: 'none' })
        }
      },
      fail: function (err) {
        handleComplete()
        console.error('diagnoseError 云函数调用失败:', err)
        wx.showToast({ title: '请求失败，请检查网络', icon: 'none' })
      }
    })
  },

  // 复制诊断结果
  handleCopyResult: function () {
    if (!this.data.codegeek.result) return

    var r = this.data.codegeek.result
    var text = '【错误原因】\n' + r.cause + '\n\n【解决方案】\n' + r.solution + '\n\n【修正代码】\n' + (r.code || '无')

    var that = this
    wx.setClipboardData({
      data: text,
      success: function () {
        that.setData({ 'codegeek.copied': true })
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' })
        setTimeout(function () {
          that.setData({ 'codegeek.copied': false })
        }, 2000)
      }
    })
  },

  // ==================== 历史记录 ====================

  // 格式化时间
  formatTimeAgo: function (dateStr) {
    if (!dateStr) return ''
    var d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    var now = new Date()
    var diff = now - d
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前'
    var month = d.getMonth() + 1
    var day = d.getDate()
    var hours = d.getHours()
    var mins = d.getMinutes()
    return month + '/' + day + ' ' + (hours < 10 ? '0' : '') + hours + ':' + (mins < 10 ? '0' : '') + mins
  },

  // 加载历史记录
  loadHistory: function (page) {
    var that = this
    var isFirstPage = page === 1

    if (isFirstPage) {
      this.setData({ 'history.loading': true, 'history.items': [], 'history.page': 1 })
    } else {
      this.setData({ 'history.loadingMore': true })
    }

    wx.cloud.callFunction({
      name: 'history',
      data: { action: 'list', page: page || 1, pageSize: 20 },
      success: function (res) {
        var result = res.result
        if (result && result.items) {
          // 处理每条记录
          var items = result.items.map(function (item) {
            item.timeAgo = that.formatTimeAgo(item.createdAt)
            // 对课堂记录预先解析 Markdown
            if (item.type === 'classroom' && item.output && item.output.summary) {
              item.outputNodes = parseMarkdown(item.output.summary)
            }
            return item
          })

          var updateData = {
            'history.loading': false,
            'history.loadingMore': false,
            'history.hasMore': result.hasMore || false,
            'history.page': result.page || 1
          }

          if (isFirstPage) {
            updateData['history.items'] = items
            updateData['history.total'] = items.length
          } else {
            // 追加到现有列表
            var merged = that.data.history.items.concat(items)
            updateData['history.items'] = merged
            updateData['history.total'] = merged.length
          }

          that.setData(updateData)
        } else if (result && result.error) {
          that.setData({ 'history.loading': false, 'history.loadingMore': false })
          wx.showToast({ title: result.error, icon: 'none' })
        }
      },
      fail: function (err) {
        that.setData({ 'history.loading': false, 'history.loadingMore': false })
        console.error('加载历史记录失败:', err)
      }
    })
  },

  // 加载更多
  handleLoadMoreHistory: function () {
    if (this.data.history.loadingMore) return
    var nextPage = this.data.history.page + 1
    this.loadHistory(nextPage)
  },

  // 展开 / 收起详情
  handleExpandHistory: function (e) {
    var id = e.currentTarget.dataset.id
    var currentExpanded = this.data.history.expandedId
    this.setData({
      'history.expandedId': currentExpanded === id ? null : id
    })
  },

  // 删除历史记录
  handleDeleteHistory: function (e) {
    var id = e.currentTarget.dataset.id
    var that = this

    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条记录吗？',
      success: function (res) {
        if (!res.confirm) return

        wx.cloud.callFunction({
          name: 'history',
          data: { action: 'delete', id: id },
          success: function () {
            // 从本地列表中移除
            var items = that.data.history.items.filter(function (item) {
              return item._id !== id
            })
            that.setData({
              'history.items': items,
              'history.total': items.length,
              'history.expandedId': null
            })
            wx.showToast({ title: '已删除', icon: 'success' })
          },
          fail: function (err) {
            console.error('删除历史记录失败:', err)
            wx.showToast({ title: '删除失败，请重试', icon: 'none' })
          }
        })
      }
    })
  }
})
