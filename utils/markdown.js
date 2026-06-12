/**
 * 轻量级 Markdown → WeChat rich-text nodes 解析器
 * 支持：标题 / 粗体 / 斜体 / 行内代码 / 代码块 / 无序列表 / 引用 / 链接 / 段落
 */

// 行内解析
function parseInline(text) {
  if (!text) return []
  var nodes = []
  var remaining = text

  while (remaining.length > 0) {
    // 粗体 **text**
    var match = remaining.match(/^\*\*(.+?)\*\*/)
    if (match) {
      nodes.push({
        name: 'strong',
        children: parseInline(match[1])
      })
      remaining = remaining.slice(match[0].length)
      continue
    }

    // 斜体 *text*
    match = remaining.match(/^\*(.+?)\*/)
    if (match) {
      nodes.push({
        name: 'em',
        children: parseInline(match[1])
      })
      remaining = remaining.slice(match[0].length)
      continue
    }

    // 行内代码 `code`
    match = remaining.match(/^`(.+?)`/)
    if (match) {
      nodes.push({
        name: 'code',
        children: [{ type: 'text', text: match[1] }]
      })
      remaining = remaining.slice(match[0].length)
      continue
    }

    // 链接 [text](url)
    match = remaining.match(/^\[(.+?)\]\((.+?)\)/)
    if (match) {
      nodes.push({
        name: 'a',
        attrs: { href: match[2] },
        children: [{ type: 'text', text: match[1] }]
      })
      remaining = remaining.slice(match[0].length)
      continue
    }

    // 普通文本（取到下一个特殊字符前）
    match = remaining.match(/^([^\*`\[<]+)/)
    if (match) {
      nodes.push({ type: 'text', text: match[1] })
      remaining = remaining.slice(match[1].length)
    } else {
      // 跳过无法识别的单字符
      nodes.push({ type: 'text', text: remaining[0] })
      remaining = remaining.slice(1)
    }
  }

  return nodes
}

/**
 * 将 Markdown 字符串解析为 rich-text 组件所需的 nodes 数组
 * @param {string} markdown - Markdown 文本
 * @returns {Array} rich-text nodes
 */
function parseMarkdown(markdown) {
  if (!markdown) return []

  var nodes = []
  var lines = markdown.split('\n')
  var i = 0

  while (i < lines.length) {
    var line = lines[i]

    // 空行跳过
    if (line.trim() === '') {
      i++
      continue
    }

    // 尝试匹配代码块（多行）
    var codeBlockMatch = line.match(/^```(\w*)/)
    if (codeBlockMatch) {
      var lang = codeBlockMatch[1]
      var codeContent = ''
      i++
      while (i < lines.length && lines[i].indexOf('```') !== 0) {
        codeContent += (codeContent ? '\n' : '') + lines[i]
        i++
      }
      i++ // 跳过结束的 ```
      nodes.push({
        name: 'pre',
        children: [{
          name: 'code',
          attrs: lang ? { class: 'language-' + lang } : {},
          children: [{ type: 'text', text: codeContent }]
        }]
      })
      continue
    }

    // 分割线
    if (/^(---|\*\*\*)$/.test(line.trim())) {
      nodes.push({ name: 'hr' })
      i++
      continue
    }

    // 标题
    var match = line.match(/^(#{1,3})\s+(.+)/)
    if (match) {
      var level = match[1].length
      nodes.push({
        name: 'h' + level,
        children: parseInline(match[2])
      })
      i++
      continue
    }

    // 引用
    match = line.match(/^>\s?(.+)/)
    if (match) {
      var quoteLines = [match[1]]
      i++
      while (i < lines.length && lines[i].indexOf('>') === 0) {
        match = lines[i].match(/^>\s?(.+)/)
        if (match) quoteLines.push(match[1])
        i++
      }
      nodes.push({
        name: 'blockquote',
        children: [{
          name: 'p',
          children: parseInline(quoteLines.join(' '))
        }]
      })
      continue
    }

    // 无序列表
    match = line.match(/^[\-\*]\s+(.+)/)
    if (match) {
      nodes.push({
        name: 'li',
        children: parseInline(match[1])
      })
      i++
      continue
    }

    // 普通段落
    var paraLines = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '' &&
      !lines[i].match(/^(#{1,3}\s|```|[\-\*]\s|>\s|---|\*\*\*)/)) {
      paraLines.push(lines[i])
      i++
    }
    nodes.push({
      name: 'p',
      children: parseInline(paraLines.join(' '))
    })
  }

  return nodes
}

module.exports = { parseMarkdown: parseMarkdown }
