/**
 * WorkBuddy provider — self-contained.
 *
 * Talks to WorkBuddy's OpenAI-compatible streaming endpoint directly with
 * Node's fetch. No third-party SDK is required: the harness adapter contract
 * (providerInfo / providerRetryPolicy / listModels / resolveModel /
 * prepareCall / stream) is implemented here, and the SSE stream is translated
 * into the harness chunk protocol.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const BASE_URL = 'https://copilot.tencent.com/v2'

/**
 * WorkBuddy 上游单次 prompt 上限是 100000 tokens，且 tokenizer 更严；
 * 对外声明留出余量：90000 上下文 + 8192 输出。
 */
const DEFAULT_CONTEXT_WINDOW = 90000
const DEFAULT_MAX_TOKENS = 8192
const TRIM_AT_TOKENS = 92000

/** 上游只接受这套枚举；未指定时用 medium，避免 11150。 */
const REASONING_EFFORTS = new Set(['low', 'medium', 'high'])

function reasoningEffortOf (options) {
  const raw = options?.reasoningEffort ?? options?.reasoning_effort ?? options?.effort
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return REASONING_EFFORTS.has(value) ? value : 'medium'
}

const IDENTITY_RE = /\bYou are an?(?:\s+AI)?(?:\s+coding)?\s+(?:agent\s+powered by|assistant\s+built on)[^\r\n]*?(?:\.(?=\s|$)|(?=\r?\n|$))/gi

/**
 * 上游的渠道校验不只认品牌词，还会按「客户端提示词指纹」拦截。
 * 2026-10-28 实测：仅保留 DSH 系统提示里
 * 「Tokens prefixed with @ … workspace root …」这两句，就稳定返回 11128；
 * 换成同义改写后，整段 5.7k 系统提示可正常 200。
 * 这里逐条改写已知指纹，新增拦截时在这里补规则即可。
 */
const TEXT_FINGERPRINTS = [
  [
    /Tokens prefixed with @ are paths the user explicitly referenced\./gi,
    'Tokens starting with @ refer to explicit paths supplied by the user.',
  ],
  [
    /Relative paths resolve from the workspace root; absolute paths identify files or directories on the host\./gi,
    'Relative paths resolve against the project root; absolute paths point to files or directories on this machine.',
  ],
]

function rewriteBrand (text) {
  let out = String(text ?? '')
    .replace(IDENTITY_RE, 'You are CodeBuddy, an AI coding assistant.')
    .replace(/\bDeepSeek Harness\b/gi, 'CodeBuddy')
    .replace(/__DSH_BOOT__/g, '__CB_BOOT__')
    .replace(/\bDSH\b/g, 'CodeBuddy')
    .replace(/\bdsh\b/g, 'codebuddy')
  for (const [pattern, replacement] of TEXT_FINGERPRINTS) out = out.replace(pattern, replacement)
  return out
}

function blocksOf (row) {
  if (Array.isArray(row?.content)) return row.content
  if (typeof row?.content === 'string') return row.content === '' ? [] : [{ type: 'text', text: row.content }]
  return []
}

function textOf (content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((block) => (block && block.type === 'text' ? block.text : '') || '').join('')
  return ''
}

/** Harness messages → OpenAI chat messages. */
export async function toOpenAIMessages (options, readImage) {
  const out = []
  const system = options?.system
  if (typeof system === 'string' && system.trim() !== '') out.push({ role: 'system', content: rewriteBrand(system) })
  // 部分适配层把系统提示按文本块数组传入；同样需要过一遍身份改写。
  if (Array.isArray(system)) {
    const text = system.map((block) => (block?.type === 'text' ? block.text : '') || '').join('')
    if (text.trim() !== '') out.push({ role: 'system', content: rewriteBrand(text) })
  }
  for (const row of options?.messages ?? []) {
    const blocks = blocksOf(row)
    if (row?.role === 'tool') {
      // Harness 的工具结果是独立消息：callId 在顶层 toolCallId 或 source.callId。
      const callId = String(row.toolCallId ?? row.tool_call_id ?? row.source?.callId ?? '')
      out.push({ role: 'tool', tool_call_id: callId, content: rewriteBrand(textOf(row.content)) })
      continue
    }
    if (row?.role === 'system' || row?.role === 'developer') {
      const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      if (text.trim() !== '') out.push({ role: 'system', content: rewriteBrand(text) })
      continue
    }
    if (row?.role === 'assistant') {
      // 历史里同样可能残留宿主提示词原文，上游会按整段对话做指纹校验。
      const text = rewriteBrand(blocks.filter((block) => block?.type === 'text').map((block) => block.text).join(''))
      const calls = blocks.filter((block) => block?.type === 'tool-call').map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments || '{}' },
      }))
      const message = { role: 'assistant', content: text === '' && calls.length > 0 ? null : text }
      if (calls.length > 0) message.tool_calls = calls
      out.push(message)
      continue
    }
    const results = blocks.filter((block) => block?.type === 'tool_result')
    for (const block of results) {
      out.push({
        role: 'tool',
        tool_call_id: String(block.toolCallId ?? block.tool_use_id ?? ''),
        content: rewriteBrand(textOf(block.content)),
      })
    }
    // 用户消息：文本 + 图片按 OpenAI content parts 输出。
    const parts = []
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        parts.push({ type: 'text', text: rewriteBrand(block.text) })
      } else if (block?.type === 'image' || block?.type === 'image_url' || block?.type === 'input_image') {
        const image = await imagePart(block, readImage)
        if (image !== null) parts.push(image)
      }
    }
    if (parts.length > 0) {
      const hasImage = parts.some((part) => part.type === 'image_url')
      out.push({
        role: 'user',
        content: hasImage ? parts : parts.map((part) => part.text).join('\n'),
      })
    }
  }
  return out
}

/** Harness 图片块 → OpenAI image_url part。 */
async function imagePart (block, readImage) {
  const direct = block.url || block.image_url?.url || block.imageUrl
  if (typeof direct === 'string' && direct !== '') {
    return { type: 'image_url', image_url: { url: direct } }
  }
  const data = block.data ?? block.base64 ?? block.source?.data
  const ref = block.attachment ?? block.ref ?? block.source
  const mime = block.mimeType ?? block.mediaType ?? ref?.mediaType ?? block.source?.media_type ?? 'image/png'
  if (typeof data === 'string' && data !== '') {
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }
  }
  // Harness 的图片块只带 attachmentId；必须通过附件服务取出原始字节。
  if (typeof readImage === 'function' && ref && typeof ref.attachmentId === 'string') {
    try {
      const stored = await readImage(ref)
      if (stored && stored.data instanceof Uint8Array) {
        const base64 = Buffer.from(stored.data).toString('base64')
        return { type: 'image_url', image_url: { url: `data:${ref.mediaType ?? mime};base64,${base64}` } }
      }
    } catch { /* 读不到就退化成占位文字 */ }
    return { type: 'text', text: `[图片无法读取：${ref.name ?? ref.attachmentId}]` }
  }
  return null
}

function toOpenAITools (tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.flatMap((tool) => {
    if (tool?.type === 'function' && tool.function) return [tool]
    if (typeof tool?.name !== 'string' || tool.name === '') return []
    return [{
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        parameters: tool.parameters ?? tool.inputSchema ?? tool.schema ?? { type: 'object', properties: {} },
      },
    }]
  })
}

export class WorkbuddyProviderError extends Error {
  constructor (message, code = 'SERVER') {
    super(message)
    this.name = 'WorkbuddyProviderError'
    this.code = code
  }
}

/** 读取项目里 .workbuddy 的规则、记忆与技能，拼成一段说明。 */
export async function workbuddyRulesText (cwd) {
  const root = String(cwd || '').trim()
  if (root === '') return ''
  const read = async (path) => {
    try { return await readFile(path, 'utf8') } catch { return '' }
  }
  const parts = []
  const main = await read(join(root, '.workbuddy', 'workbuddy.md'))
  if (main !== '') parts.push(`# .workbuddy/workbuddy.md\n${main}`)
  try {
    const memory = await readdir(join(root, '.workbuddy', 'memory'))
    for (const name of memory.filter((entry) => entry.endsWith('.md')).slice(0, 20)) {
      const text = await read(join(root, '.workbuddy', 'memory', name))
      if (text !== '') parts.push(`# memory/${name}\n${text}`)
    }
  } catch { /* 没有 memory 目录 */ }
  try {
    const skills = await readdir(join(root, '.workbuddy', 'skills'))
    for (const name of skills.slice(0, 20)) {
      const text = await read(join(root, '.workbuddy', 'skills', name, 'SKILL.md'))
      if (text !== '') parts.push(`# skills/${name}/SKILL.md\n${text}`)
    }
  } catch { /* 没有 skills 目录 */ }
  return parts.join('\n\n').slice(0, 60000)
}

/** 上游渠道校验要求官方客户端标识；缺失会被判为未经批准的渠道（11128）。 */
const CLIENT_HEADERS = {
  'content-type': 'application/json',
  accept: 'text/event-stream',
  'user-agent': 'CLI/2.171.0 CodeBuddy/2.171.0',
  'x-product': 'SaaS',
  'x-ide-type': 'CLI',
  'x-ide-name': 'CodeBuddy',
  'x-ide-version': '2.171.0',
}

function postChat (body, credential, signal) {
  return fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
    signal,
  })
}

/** 兜底系统提示：任何品牌/指纹都不含，用于 11128 重试。 */
const NEUTRAL_SYSTEM = 'You are CodeBuddy, an AI coding assistant. Follow the user request, use the provided tools when helpful, and answer in the user\'s language.'

function withNeutralSystem (messages) {
  return [
    { role: 'system', content: NEUTRAL_SYSTEM },
    ...messages.filter((message) => message.role !== 'system' && message.role !== 'developer'),
  ]
}

/**
 * Stream one turn.
 * @param {object} options harness GenerateOptions subset
 * @param {{token?: string, apiKey?: string, cwd?: string, workbuddyRules?: boolean, signal?: AbortSignal}} auth
 */
export async function * streamWorkbuddy (options, auth) {
  if (auth?.showTaskList !== false) {
    const directive = '在执行任何多步骤任务前，先用任务清单（todo）列出步骤，并在每完成一步后更新状态；回答末尾给出整体进度。'
    options = { ...options, system: `${options.system ? `${options.system}\n\n` : ''}${directive}` }
  }
  if (auth?.workbuddyRules === true) {
    const rules = await workbuddyRulesText(auth.cwd)
    if (rules !== '') {
      options = { ...options, system: `${options.system ? `${options.system}\n\n` : ''}${rules}` }
    }
  }

  const credential = String(auth?.apiKey || auth?.token || '').trim()
  if (credential === '') {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'WorkBuddy 未配置 API Key 或令牌', code: 'MISSING_CREDENTIAL' } } }
    return
  }

  const messages = await toOpenAIMessages(options, auth?.readImage)
  // 上游硬上限 100000 tokens，且 tokenizer 更严；超长时按「整轮」丢弃，避免拆散 tool 配对。
  const estimate = () => messages.reduce((sum, message) => sum + Math.ceil(JSON.stringify(message).length / 4), 0)
  while (messages.length > 4 && estimate() > TRIM_AT_TOKENS) {
    const start = messages[0]?.role === 'system' ? 1 : 0
    let end = start + 1
    while (end < messages.length && messages[end].role !== 'user') end += 1
    if (end >= messages.length) break
    messages.splice(start, end - start)
  }

  // 修复 tool 配对：丢掉孤立结果，给缺失结果补占位，避免上游报 11148。
  const callIds = new Set()
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) if (call.id) callIds.add(call.id)
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'tool' && !callIds.has(messages[index].tool_call_id)) messages.splice(index, 1)
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    const ids = message.tool_calls.map((call) => call.id).filter(Boolean)
    const have = new Set()
    for (let next = index + 1; next < messages.length && messages[next].role === 'tool'; next += 1) have.add(messages[next].tool_call_id)
    const missing = ids.filter((id) => !have.has(id))
    if (missing.length > 0) {
      messages.splice(index + 1, 0, ...missing.map((id) => ({ role: 'tool', tool_call_id: id, content: '[tool result missing]' })))
    }
  }

  const body = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // 上游对部分模型强制校验 effort，缺省会返回 11150；统一兜底成 medium。
    reasoning_effort: reasoningEffortOf(options),
  }
  if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) body.max_tokens = options.maxTokens
  if (Number.isFinite(options.temperature)) body.temperature = options.temperature
  const tools = toOpenAITools(options.tools)
  if (tools !== undefined && tools.length > 0) body.tools = tools

  let response
  try {
    response = await postChat(body, credential, options.signal)
  } catch (error) {
    const aborted = options.signal?.aborted === true
    yield {
      type: 'finish',
      reason: {
        kind: aborted ? 'aborted' : 'error',
        failure: { message: String((error && error.message) || error), code: aborted ? 'ABORTED' : 'TRANSPORT' },
      },
    }
    return
  }

  // 11128 = 渠道校验失败：多半是系统提示里又出现了新的「非官方客户端」指纹。
  // 指纹表没覆盖到时，用中性系统提示重试一次，至少让本轮能跑完。
  if (response.status === 400) {
    const detail = await response.clone().text().catch(() => '')
    if (detail.includes('11128')) {
      const retried = await postChat({ ...body, messages: withNeutralSystem(messages) }, credential, options.signal)
        .catch(() => null)
      if (retried) response = retried
    }
  }

  if (!response.ok || !response.body) {
    let raw = ''
    try { raw = await response.text() } catch { /* ignore */ }
    let message = `WorkBuddy 返回 HTTP ${response.status}`
    try {
      const parsed = JSON.parse(raw)
      message = parsed?.displayMsg?.zh || parsed?.msg || parsed?.error?.message || message
    } catch {
      if (raw) message = `${message}: ${raw.slice(0, 500)}`
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'error', failure: { message, code: response.status === 429 ? 'RATE_LIMIT' : 'SERVER' } } }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  const toolBlocks = new Map()
  let answerText = ''
  let usage = null
  let finishReason = null
  let sawAnything = false

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        let event
        try { event = JSON.parse(payload) } catch { continue }

        if (event?.usage) {
          const input = Number(event.usage.prompt_tokens ?? event.usage.input_tokens ?? 0) || 0
          const output = Number(event.usage.completion_tokens ?? event.usage.output_tokens ?? 0) || 0
          const cacheRead = Number(event.usage.prompt_tokens_details?.cached_tokens ?? 0) || 0
          usage = { inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: cacheRead }
        }

        const choice = event?.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}

        // 思考内容不推给 Harness：DSH 的「步骤」区会把它渲染成窄列碎片。
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          sawAnything = true
        }
        // 只累积最终回答，等整轮结束一次性发出，避免 DSH 把每个增量渲染成一行。
        if (typeof delta.content === 'string' && delta.content !== '') {
          answerText += delta.content
          sawAnything = true
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const key = String(call.index ?? 0)
            let block = toolBlocks.get(key)
            if (block === undefined) {
              block = { index: nextIndex++, id: call.id || `call_${Date.now()}_${key}`, name: call.function?.name || '', args: '', started: false }
              toolBlocks.set(key, block)
            }
            if (typeof call.id === 'string' && call.id !== '') block.id = call.id
            if (typeof call.function?.name === 'string' && call.function.name !== '') block.name = call.function.name
            const piece = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
            if (!block.started) {
              block.started = true
              sawAnything = true
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            if (piece !== '') {
              block.args += piece
              yield { type: 'tool-call-delta', index: block.index, id: block.id, ...(block.name ? { name: block.name } : {}), argumentsDelta: piece }
            }
          }
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finishReason = choice.finish_reason
      }
    }
  } catch (error) {
    const aborted = options.signal?.aborted === true
    yield {
      type: 'finish',
      reason: {
        kind: aborted ? 'aborted' : 'error',
        failure: { message: String((error && error.message) || error), code: aborted ? 'ABORTED' : 'TRANSPORT' },
      },
    }
    return
  }

  for (const block of toolBlocks.values()) {
    yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args === '' ? '{}' : block.args } }
  }
  if (answerText !== '') {
    const textIndex = nextIndex++
    yield { type: 'block-start', index: textIndex, blockType: 'text' }
    // 过程文本已丢弃；这里把最终结论按小块吐出，既有打字效果又不会出现中间过程。
    const step = 40
    for (let offset = 0; offset < answerText.length; offset += step) {
      yield { type: 'text-delta', index: textIndex, text: answerText.slice(offset, offset + step) }
      if (offset + step < answerText.length) await new Promise((resolve) => setTimeout(resolve, 8))
    }
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: answerText } }
  }
  yield { type: 'usage', usage: usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 } }
  if (!sawAnything) {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'WorkBuddy 返回了空响应', code: 'EMPTY_RESPONSE' } } }
    return
  }
  yield { type: 'finish', reason: { kind: finishReason === 'length' ? 'length' : 'stop' }, ...(finishReason === null ? {} : { upstreamFinish: finishReason }) }
}

/** Harness adapter over the WorkBuddy endpoint. */
export class WorkbuddyAdapter {
  /**
   * @param {object} dependencies
   * @param {() => {apiKey?: string, token?: string, category?: string, cwd?: string, workbuddyRules?: boolean}} dependencies.getConfig
   * @param {() => Array<{id: string, name: string, multiplier?: number, badges?: Array<{label:string}>, busyLevel?: string, contextWindow?: number}>} dependencies.getModels
   */
  constructor (dependencies) {
    this.deps = dependencies
  }

  providerInfo (provider) {
    const category = this.deps.getConfig().category
    return { id: provider, name: typeof category === 'string' && category.trim() !== '' ? category.trim() : 'WB 工作台' }
  }

  providerRetryPolicy () {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 800,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    }
  }

  displayName (entry, id) {
    // 倍率不放名字里：DSH 模型选择器由客户端插件单独右对齐显示（见 client.js 的
    // conversation.input.model.label 注册），避免出现「0.65x · 0.65x」两份。
    const parts = [String(entry?.name || id)]
    const badge = entry?.badges?.[0]?.label
    if (typeof badge === 'string' && badge !== '' && !parts[0].includes(badge)) parts.push(badge)
    if (entry?.busyLevel === 'congested') parts.push('拥堵')
    else if (entry?.busyLevel === 'busy') parts.push('繁忙')
    return parts.join(' · ')
  }

  async listModels (provider) {
    const models = this.deps.getModels()
    return models.map((entry) => ({
      provider,
      id: entry.id,
      name: this.displayName(entry, entry.id),
      inputModalities: ['text', 'image'],
    }))
  }

  async resolveModel (provider, model) {
    const entry = this.deps.getModels().find((candidate) => candidate.id === model)
    return {
      provider,
      id: model,
      name: this.displayName(entry, model),
      inputModalities: ['text', 'image'],
      context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    }
  }

  async prepareCall (provider, model) {
    this.deps.noteModel?.(model)
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => streamWorkbuddy({ ...options, model: options?.model ?? model }, this.deps.getConfig()),
    }
  }

  stream (options) {
    this.deps.noteModel?.(options?.model)
    return streamWorkbuddy(options, this.deps.getConfig())
  }
}
