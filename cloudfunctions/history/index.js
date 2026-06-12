// ============================================================
// history 云函数
// 提供历史记录分页查询和单条删除
// ============================================================
var cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
var db = cloud.database()

exports.main = async function (event, context) {
  var action = event.action

  try {
    // ======== 分页列表 ========
    if (action === 'list') {
      var page = event.page || 1
      var pageSize = Math.min(event.pageSize || 20, 50)
      var skip = (page - 1) * pageSize

      var result = await db.collection('history')
        .orderBy('createdAt', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get()

      return {
        items: result.data,
        page: page,
        hasMore: result.data.length === pageSize
      }
    }

    // ======== 删除单条 ========
    if (action === 'delete') {
      if (!event.id) {
        return { error: '缺少记录 ID' }
      }

      await db.collection('history').doc(event.id).remove()
      return { success: true }
    }

    return { error: '未知操作: ' + action }

  } catch (err) {
    console.error('[history]', err.message)
    return { error: err.message || '云函数内部错误' }
  }
}
