// 最简单的测试云函数 — 验证云函数本身能正常工作
exports.main = async function (event, context) {
  return {
    ok: true,
    time: Date.now(),
    message: '云函数基础链路正常'
  }
}
