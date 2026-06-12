// ============================================================
// diagnoseError 云函数（v3 重写版）
// 接收报错文本 → 调用大模型 → 返回结构化诊断结果
// ============================================================
var cloud = require('wx-server-sdk')
var https = require('https')
var http = require('http')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// ============ 配置（硬编码，不依赖环境变量）============
var CONFIG = {
  apiUrl: process.env.LLM_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  apiKey: process.env.LLM_API_KEY || 'sk-57d14ed1e38e4613a814d0f7972f8f56',
  model: process.env.LLM_MODEL || 'qwen-plus',
  httpTimeout: 30000,       // 单次 HTTP 超时（30s 内 API 应有响应）
  overallTimeout: 50000     // 整体超时（< SDK 默认超时，留冷启动余量）
}

// ============ Prompt ============
var SYSTEM_PROMPT =
  '你是一个资深的软件工程专家。请分析以下报错信息或代码片段，指出根本原因，并给出直接可用的修改后代码。\n\n' +
  '请严格按照以下 JSON 格式返回（不要输出任何其他内容）：\n' +
  '{\n' +
  '  "tags": ["错误类型1", "错误类型2"],\n' +
  '  "cause": "根本原因（一句话概括）",\n' +
  '  "solution": "解决步骤（分点说明，每点一行，用 1. 2. 3. 开头）",\n' +
  '  "code": "修正后的完整代码片段",\n' +
  '  "detail": "详细的调用栈分析和预防措施（Markdown 格式）"\n' +
  '}'

// ============ HTTP 请求工具（Promise 版）============
function httpRequest(url, body, timeout) {
  return new Promise(function (resolve, reject) {
    var urlObj = new (require('url').URL)(url)
    var isHttps = urlObj.protocol === 'https:'
    var httpMod = isHttps ? https : http
    var payload = JSON.stringify(body)

    var options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.apiKey
      },
      timeout: timeout
    }

    console.log('[HTTP] 请求 →', urlObj.hostname)

    var req = httpMod.request(options, function (res) {
      console.log('[HTTP] 状态码:', res.statusCode)
      var body = ''
      res.on('data', function (chunk) { body += chunk })
      res.on('end', function () {
        try {
          resolve({ result: JSON.parse(body), statusCode: res.statusCode })
        } catch (e) {
          reject(new Error('JSON 解析失败: ' + body.slice(0, 300)))
        }
      })
      res.on('error', function (err) {
        reject(new Error('响应流错误: ' + err.message))
      })
    })

    req.on('timeout', function () {
      req.destroy()
      reject(new Error('LLM API 请求超时 (' + timeout + 'ms)'))
    })
    req.on('error', function (err) {
      reject(new Error('网络请求失败: ' + err.message))
    })

    req.write(payload)
    req.end()
  })
}

// ============ 带超时保护的 API 调用 ============
function callLLMWithTimeout(requestBody) {
  var timerId = null

  var timeoutPromise = new Promise(function (_, reject) {
    timerId = setTimeout(function () {
      reject(new Error('LLM 请求整体超时 (' + CONFIG.overallTimeout + 'ms)'))
    }, CONFIG.overallTimeout)
  })

  var request = httpRequest(CONFIG.apiUrl, requestBody, CONFIG.httpTimeout)

  return Promise.race([request, timeoutPromise]).then(function (result) {
    clearTimeout(timerId)
    return result
  }).catch(function (err) {
    clearTimeout(timerId)
    throw err
  })
}

// ============ 安全解析 LLM 返回的 JSON ============
function parseDiagnosisJSON(rawText) {
  if (!rawText) return null

  // 尝试直接解析
  try { return JSON.parse(rawText) } catch (e1) {}

  // 尝试提取 ```json ... ``` 代码块
  var match = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (match) {
    try { return JSON.parse(match[1]) } catch (e2) {}
  }

  // 尝试提取 { ... } 对象
  match = rawText.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch (e3) {}
  }

  return null
}

// ============ 主入口 ============
exports.main = async function (event, context) {
  var startTime = Date.now()

  console.log('[START] diagnoseError, 输入长度:', event.errorText ? event.errorText.length : 0)

  try {
    // === 参数校验 ===
    if (!event.errorText || !event.errorText.trim()) {
      return { error: '缺少报错信息', _ts: Date.now() }
    }

    var errorText = event.errorText
    if (errorText.length > 5000) {
      errorText = errorText.slice(0, 5000)
    }

    // === 构建请求体（使用 system role）===
    console.log('[STEP-1] 发起 LLM 请求, model:', CONFIG.model)
    var requestBody = {
      model: CONFIG.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: errorText }
      ],
      max_tokens: 2048,
      temperature: 0.3
    }

    // === 调用 LLM API ===
    console.log('[STEP-2] 等待 LLM 响应...')
    var llmResult
    try {
      llmResult = await callLLMWithTimeout(requestBody)
    } catch (err) {
      console.error('[STEP-2] LLM 调用失败:', err.message)
      return { error: 'AI 服务请求失败: ' + err.message, _stage: 'llm', _ts: Date.now() }
    }

    // === 检查 HTTP 状态 ===
    if (llmResult.statusCode !== 200) {
      var apiErr = ''
      if (llmResult.result && llmResult.result.error) {
        apiErr = llmResult.result.error.message || JSON.stringify(llmResult.result.error)
      } else {
        apiErr = 'HTTP ' + llmResult.statusCode
      }
      console.error('[STEP-2] API 非200:', llmResult.statusCode, apiErr)
      return {
        error: 'AI 服务异常: ' + apiErr,
        _statusCode: llmResult.statusCode,
        _stage: 'api-status',
        _ts: Date.now()
      }
    }

    // === 提取 LLM 返回文本 ===
    var rawText = ''
    var choices = llmResult.result && llmResult.result.choices
    if (choices && choices[0] && choices[0].message && choices[0].message.content) {
      rawText = choices[0].message.content
    }

    if (!rawText) {
      console.error('[STEP-2] 空响应:', JSON.stringify(llmResult.result).slice(0, 500))
      return { error: 'AI 未返回有效内容', _stage: 'empty', _ts: Date.now() }
    }

    console.log('[STEP-2] 响应长度:', rawText.length)

    // === 解析诊断 JSON ===
    var diagnosis = parseDiagnosisJSON(rawText)

    if (diagnosis) {
      console.log('[DONE] 耗时:', Date.now() - startTime, 'ms')

      // === 写入历史记录 ===
      try {
        var db = cloud.database()
        await db.collection('history').add({
          data: {
            type: 'codegeek',
            title: (diagnosis.cause || '报错诊断').slice(0, 60),
            inputPreview: (errorText || '').slice(0, 80),
            output: {
              tags: diagnosis.tags || [],
              cause: diagnosis.cause || '',
              solution: diagnosis.solution || '',
              code: diagnosis.code || '',
              detail: diagnosis.detail || ''
            },
            createdAt: db.serverDate()
          }
        })
      } catch (dbErr) {
        console.warn('[DB] 历史记录写入失败（非致命）:', dbErr.message)
      }

      return {
        result: {
          tags: diagnosis.tags || [],
          cause: diagnosis.cause || '',
          solution: diagnosis.solution || '',
          code: diagnosis.code || '',
          detail: diagnosis.detail || ''
        },
        _ts: Date.now()
      }
    } else {
      // 降级：将原始文本作为 detail
      console.warn('[WARN] JSON 解析失败，降级为纯文本')
      return {
        result: {
          tags: ['解析异常'],
          cause: 'LLM 返回格式异常',
          solution: '请查看详细分析',
          code: '',
          detail: rawText
        },
        _ts: Date.now()
      }
    }

  } catch (fatalErr) {
    console.error('[FATAL]', fatalErr.message, fatalErr.stack)
    return {
      error: '云函数内部异常: ' + (fatalErr.message || '未知错误'),
      _fatal: true,
      _ts: Date.now()
    }
  }
}
