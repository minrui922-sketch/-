// ============================================================
// analyzeImage 云函数（v3 重写版）
// 接收云存储 fileID → 获取临时链接 → 调用视觉模型 → 返回摘要
// ============================================================
var cloud = require('wx-server-sdk')
var https = require('https')
var http = require('http')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// ============ 配置（硬编码，不依赖环境变量）============
var CONFIG = {
  apiUrl: process.env.LLM_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  apiKey: process.env.LLM_API_KEY || 'sk-57d14ed1e38e4613a814d0f7972f8f56',
  model: process.env.LLM_MODEL || 'qwen-vl-max',
  httpTimeout: 30000,       // 单次 HTTP 超时（30s 内 API 应有响应）
  overallTimeout: 50000,    // 整体超时（< SDK 默认超时，留冷启动余量）
  getUrlTimeout: 15000      // getTempFileURL 超时
}

// ============ Prompt ============
var SYSTEM_PROMPT = '你是一个极速学术助手。请对这张课堂 PPT/文献图片进行文字提取，并精简提炼出核心概念、公式和要点，字数在 200 字以内，使用清晰的 Markdown 列表返回。'

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

// ============ 带超时保护的 getTempFileURL ============
function getTempFileURLSafe(fileID) {
  var timerId = null

  var timeoutPromise = new Promise(function (_, reject) {
    timerId = setTimeout(function () {
      reject(new Error('getTempFileURL 超时 (' + CONFIG.getUrlTimeout / 1000 + 's)'))
    }, CONFIG.getUrlTimeout)
  })

  var request = cloud.getTempFileURL({ fileList: [fileID] })

  return Promise.race([request, timeoutPromise]).then(function (result) {
    clearTimeout(timerId)
    return result
  }).catch(function (err) {
    clearTimeout(timerId)
    throw err
  })
}

// ============ 主入口 ============
exports.main = async function (event, context) {
  var startTime = Date.now()

  console.log('[START] analyzeImage, fileID:', event.fileID)

  try {
    // === 参数校验 ===
    if (!event.fileID) {
      return { error: '缺少图片 fileID 参数', _ts: Date.now() }
    }

    // === Step 1: 获取图片临时链接 ===
    console.log('[STEP-1] 获取临时链接...')
    var downloadResult
    try {
      downloadResult = await getTempFileURLSafe(event.fileID)
    } catch (err) {
      console.error('[STEP-1] 失败:', err.message)
      return { error: '获取图片链接失败: ' + err.message, _stage: 'temp-url', _ts: Date.now() }
    }

    var fileInfo = downloadResult.fileList && downloadResult.fileList[0]
    if (!fileInfo || fileInfo.status !== 0) {
      return {
        error: '图片链接已过期或不存在（status=' + (fileInfo ? fileInfo.status : '?') + '），请重新上传',
        _stage: 'temp-url-status',
        _ts: Date.now()
      }
    }
    console.log('[STEP-1] 成功 ✓')

    // === Step 2: 构建请求体（视觉模型）===
    console.log('[STEP-2] 发起 LLM 请求, model:', CONFIG.model)
    var requestBody = {
      model: CONFIG.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileInfo.tempFileURL } }
          ]
        }
      ],
      max_tokens: 1024,
      temperature: 0.3
    }

    // === Step 3: 调用 LLM API ===
    console.log('[STEP-3] 等待 LLM 响应...')
    var llmResult
    try {
      llmResult = await callLLMWithTimeout(requestBody)
    } catch (err) {
      console.error('[STEP-3] LLM 调用失败:', err.message)
      return { error: 'AI 服务请求失败: ' + err.message, _stage: 'llm', _ts: Date.now() }
    }

    // === Step 4: 解析响应 ===
    if (llmResult.statusCode !== 200) {
      var apiErr = ''
      if (llmResult.result && llmResult.result.error) {
        apiErr = llmResult.result.error.message || JSON.stringify(llmResult.result.error)
      } else {
        apiErr = 'HTTP ' + llmResult.statusCode
      }
      console.error('[STEP-4] API 非200:', llmResult.statusCode, apiErr)
      return {
        error: 'AI 服务异常: ' + apiErr,
        _statusCode: llmResult.statusCode,
        _stage: 'api-status',
        _ts: Date.now()
      }
    }

    var summary = ''
    var choices = llmResult.result && llmResult.result.choices
    if (choices && choices[0] && choices[0].message && choices[0].message.content) {
      summary = choices[0].message.content
    }

    if (!summary) {
      console.error('[STEP-4] 空响应:', JSON.stringify(llmResult.result).slice(0, 500))
      return { error: 'AI 未返回有效内容', _stage: 'empty', _ts: Date.now() }
    }

    console.log('[DONE] 耗时:', Date.now() - startTime, 'ms, 摘要长度:', summary.length)

    // === Step 5: 写入历史记录 ===
    try {
      var db = cloud.database()
      await db.collection('history').add({
        data: {
          type: 'classroom',
          title: (summary || '').slice(0, 60),
          inputPreview: event.fileID || '',
          output: { summary: summary },
          createdAt: db.serverDate()
        }
      })
    } catch (dbErr) {
      console.warn('[DB] 历史记录写入失败（非致命）:', dbErr.message)
    }

    return { summary: summary, _ts: Date.now() }

  } catch (fatalErr) {
    console.error('[FATAL]', fatalErr.message, fatalErr.stack)
    return {
      error: '云函数内部异常: ' + (fatalErr.message || '未知错误'),
      _fatal: true,
      _ts: Date.now()
    }
  }
}
