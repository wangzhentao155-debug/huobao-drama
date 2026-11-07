/**
 * LibTV 视频生成 Adapter — agent-im 会话接口
 *
 * - POST /openapi/session          创建会话/发送自然语言生成请求
 * - GET  /openapi/session/{id}     轮询会话消息，提取 assistant 返回的视频 URL
 * - 鉴权：Authorization: Bearer <LIBTV_ACCESS_KEY>
 *
 * LibTV 是会话式 Agent API，不暴露单模型参数；模型/时长/画幅作为自然语言
 * 指令写入 message，实际由 LibTV 侧编排。本适配器只做“提交会话 + 轮询结果”。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'

const DEFAULT_BASE_URL = 'https://im.liblib.tv'
const DEFAULT_MODEL = 'libtv'

function baseUrl(config: AIConfig): string {
  return (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === 'string' && !!u.trim()) : []
  } catch {
    return []
  }
}

function buildMessage(record: VideoGenerationRecord, model: string): string {
  const parts = [String(record.prompt || '').trim()]
  if (model && model !== DEFAULT_MODEL) parts.push(`使用模型：${model}`)
  if (record.duration) parts.push(`时长：${Math.round(Number(record.duration))} 秒`)
  if (record.aspectRatio) parts.push(`画幅：${record.aspectRatio}`)
  if (record.resolution) parts.push(`分辨率：${record.resolution}`)

  const refs = [
    record.firstFrameUrl || record.imageUrl,
    record.lastFrameUrl,
    ...parseUrlArray(record.referenceImageUrls),
    ...parseUrlArray(record.referenceVideoUrls),
  ].filter((url): url is string => typeof url === 'string' && !!url.trim())

  if (refs.length) parts.push(`参考素材：${refs.join('、')}`)
  return parts.filter(Boolean).join('\n')
}

function collectStrings(value: any): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') {
    const out: string[] = []
    for (const key of ['text', 'content', 'url', 'video_url', 'videoUrl']) {
      if (value[key] !== undefined) out.push(...collectStrings(value[key]))
    }
    if (!out.length) {
      for (const child of Object.values(value)) out.push(...collectStrings(child))
    }
    return out
  }
  return []
}

function extractVideoUrlFromMessages(messages: any): string | null {
  if (!Array.isArray(messages)) return null
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || '').toLowerCase()
    if (role !== 'assistant' && role !== 'agent') continue
    const text = collectStrings(message.content ?? message).join('\n')
    const urls = text.match(/https?:\/\/[^\s"'<>]+/g) || []
    const video = urls.find(url => /\.(mp4|mov|webm|m3u8)(\?|$)/i.test(url))
    if (video) return video
  }
  return null
}

function assistantFailure(messages: any): string | null {
  if (!Array.isArray(messages)) return null
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || '').toLowerCase()
    if (role !== 'assistant' && role !== 'agent') continue
    const text = collectStrings(message.content ?? message).join('\n')
    if (/生成失败|任务失败|generation failed|task failed/i.test(text)) {
      return text.slice(0, 500)
    }
  }
  return null
}

export class LibTVVideoAdapter implements VideoProviderAdapter {
  provider = 'libtv'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    if (!config.apiKey) throw new Error('LibTV 未配置 Access Key')
    const message = buildMessage(record, String(record.model || config.model || DEFAULT_MODEL).trim())
    if (!message) throw new Error('LibTV 需要提示词或参考素材')
    return {
      url: `${baseUrl(config)}/openapi/session`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: { message },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const data = result?.data || result
    const sessionId = data?.sessionId || data?.session_id
    if (sessionId) return { isAsync: true, taskId: String(sessionId) }
    throw new Error(result?.message || result?.error?.message || 'LibTV 响应中缺少 sessionId')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: `${baseUrl(config)}/openapi/session/${encodeURIComponent(taskId)}?afterSeq=0`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const data = result?.data || result
    const messages = data?.messages
    const videoUrl = extractVideoUrlFromMessages(messages)
    if (videoUrl) return { status: 'completed', videoUrl }
    const failure = assistantFailure(messages)
    if (failure) return { status: 'failed', error: failure }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const data = result?.data || result
    return extractVideoUrlFromMessages(data?.messages)
  }
}
