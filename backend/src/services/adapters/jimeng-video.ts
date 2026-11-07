/**
 * 即梦（Jimeng）视频生成 Adapter — 火山引擎 Visual API
 *
 * - POST https://visual.volcengineapi.com?Action=CVSync2AsyncSubmitTask&Version=2022-08-31
 * - POST https://visual.volcengineapi.com?Action=CVSync2AsyncGetResult&Version=2022-08-31
 * - 鉴权：火山引擎 V4 签名（AccessKey + SecretKey）
 * - Service=cv, Region=cn-north-1
 *
 * 配置约定：apiKey 填写 `AccessKey:SecretKey`（也兼容 JSON {"accessKey","secretKey"}）。
 */
import crypto from 'crypto'
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'

const DEFAULT_BASE_URL = 'https://visual.volcengineapi.com'
const API_VERSION = '2022-08-31'
const REGION = 'cn-north-1'
const SERVICE = 'cv'
const SUBMIT_ACTION = 'CVSync2AsyncSubmitTask'
const QUERY_ACTION = 'CVSync2AsyncGetResult'

const T2V_KEYS = new Set(['jimeng_t2v_v30_1080p', 'jimeng_ti2v_v30_pro', 'jimeng_vgfm_t2v_l20'])
const I2V_FIRST_KEYS = new Set(['jimeng_i2v_first_v30_1080', 'jimeng_i2v_first_v30'])
const I2V_FIRST_TAIL_KEYS = new Set(['jimeng_i2v_first_tail_v30_1080', 'jimeng_i2v_first_tail_v30'])
const DEFAULT_T2V_KEY = 'jimeng_t2v_v30_1080p'
const DEFAULT_I2V_FIRST_KEY = 'jimeng_i2v_first_v30_1080'
const DEFAULT_I2V_FIRST_TAIL_KEY = 'jimeng_i2v_first_tail_v30_1080'
const PROMPT_MAX = 800
const VALID_RATIOS = new Set(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'])

interface Credentials {
  accessKey: string
  secretKey: string
}

function parseCredentials(apiKey: string): Credentials {
  const raw = String(apiKey || '').trim()
  if (!raw) throw new Error('即梦未配置 AccessKey:SecretKey')
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      const accessKey = parsed.accessKey || parsed.access_key || parsed.ak
      const secretKey = parsed.secretKey || parsed.secret_key || parsed.sk
      if (accessKey && secretKey) return { accessKey: String(accessKey), secretKey: String(secretKey) }
    } catch {
      // fall through
    }
  }
  const index = raw.indexOf(':')
  if (index <= 0 || index === raw.length - 1) {
    throw new Error('即梦凭据格式应为 AccessKey:SecretKey')
  }
  return { accessKey: raw.slice(0, index), secretKey: raw.slice(index + 1) }
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmac(key: string | Buffer, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest()
}

/** 火山引擎 V4 签名；返回 Authorization 与 X-Date */
function signVolcengine(params: {
  credentials: Credentials
  method: string
  url: URL
  headers: Record<string, string>
  payload: string
}): Record<string, string> {
  const { credentials, method, url, headers, payload } = params
  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = datetime.slice(0, 8)

  const signed: Record<string, string> = { ...headers, 'X-Date': datetime }
  const headerKeys = Object.keys(signed).map(key => key.toLowerCase()).sort()
  const canonicalHeaders = headerKeys
    .map(key => `${key}:${String(signed[Object.keys(signed).find(k => k.toLowerCase() === key)!]).trim()}\n`)
    .join('')
  const signedHeaders = headerKeys.join(';')

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')

  const canonicalRequest = [
    method,
    url.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join('\n')

  const credentialScope = `${date}/${REGION}/${SERVICE}/request`
  const stringToSign = [
    'HMAC-SHA256',
    datetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmac(credentials.secretKey, date)
  const kRegion = hmac(kDate, REGION)
  const kService = hmac(kRegion, SERVICE)
  const kSigning = hmac(kService, 'request')
  const signature = hmac(kSigning, stringToSign).toString('hex')

  return {
    ...signed,
    Authorization: `HMAC-SHA256 Credential=${credentials.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

function errorMessage(result: any, fallback: string): string {
  const error = result?.ResponseMetadata?.Error
  const code = error?.Code || result?.code
  const message = error?.Message || result?.message || fallback
  const requestId = result?.ResponseMetadata?.RequestId || result?.request_id
  return `${code != null ? `[${code}] ` : ''}${message}${requestId ? ` (request_id: ${requestId})` : ''}`
}

function buildUrl(baseUrl: string, action: string): URL {
  const url = new URL(baseUrl || DEFAULT_BASE_URL)
  url.searchParams.set('Action', action)
  url.searchParams.set('Version', API_VERSION)
  return url
}

function jsonRequest(config: AIConfig, action: string, body: Record<string, any>): ProviderRequest {
  const credentials = parseCredentials(config.apiKey)
  const url = buildUrl(config.baseUrl, action)
  const payload = JSON.stringify(body)
  const headers = signVolcengine({
    credentials,
    method: 'POST',
    url,
    headers: {
      Host: url.host,
      'Content-Type': 'application/json',
      'X-Content-Sha256': sha256Hex(payload),
    },
    payload,
  })
  return {
    url: url.toString(),
    method: 'POST',
    headers,
    body,
  }
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

function normalizeFrames(duration?: number | null): 121 | 241 {
  const seconds = Number(duration || 5)
  return Number.isFinite(seconds) && seconds > 7.5 ? 241 : 121
}

function normalizeRatio(ratio?: string | null): string {
  const value = String(ratio || '').trim()
  return VALID_RATIOS.has(value) ? value : '16:9'
}

export class JimengVideoAdapter implements VideoProviderAdapter {
  provider = 'jimeng'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const prompt = String(record.prompt || '').trim()
    if (!prompt) throw new Error('即梦视频需要提示词')
    if (prompt.length > PROMPT_MAX) throw new Error(`即梦提示词上限 ${PROMPT_MAX} 字符`)

    const firstFrame = String(record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = String(record.lastFrameUrl || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    if (refImages.length || refVideos.length || refAudios.length) {
      throw new Error('即梦当前适配器仅支持首帧/尾帧，不支持多参考图/参考视频/参考音频')
    }

    const requested = String(record.model || config.model || '').trim()
    const reqKey = T2V_KEYS.has(requested) || I2V_FIRST_KEYS.has(requested) || I2V_FIRST_TAIL_KEYS.has(requested)
      ? requested
      : DEFAULT_T2V_KEY

    const body: Record<string, any> = {
      req_key: reqKey,
      prompt,
      seed: record.seed ?? -1,
      frames: normalizeFrames(record.duration),
    }

    if (I2V_FIRST_TAIL_KEYS.has(reqKey) || I2V_FIRST_KEYS.has(reqKey)) {
      if (!firstFrame) throw new Error('即梦图生视频需要首帧图')
      if (I2V_FIRST_TAIL_KEYS.has(reqKey)) {
        if (!lastFrame) throw new Error('即梦首尾帧模式需要尾帧图')
        body.image_urls = [firstFrame, lastFrame]
      } else {
        if (lastFrame) throw new Error('即梦首帧模式不支持尾帧图')
        body.image_urls = [firstFrame]
      }
    } else {
      if (firstFrame || lastFrame) throw new Error('即梦文生视频模型不支持首帧/尾帧图')
      body.aspect_ratio = normalizeRatio(record.aspectRatio)
    }

    return jsonRequest(config, SUBMIT_ACTION, body)
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result?.code !== 10000) {
      throw new Error(errorMessage(result, '即梦任务提交失败'))
    }
    const taskId = result?.data?.task_id
    if (taskId != null) return { isAsync: true, taskId: String(taskId) }
    throw new Error(errorMessage(result, '即梦响应中缺少 data.task_id'))
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const requested = String(config.model || '').trim()
    const reqKey = requested || DEFAULT_T2V_KEY
    return jsonRequest(config, QUERY_ACTION, { req_key: reqKey, task_id: taskId })
  }

  parsePollResponse(result: any): VideoPollResponse {
    if (result?.code !== 10000) {
      return { status: 'failed', error: errorMessage(result, '即梦任务查询失败') }
    }
    const data = result?.data || {}
    const status = String(data.status || '')
    const videoUrl = data.video_url || data.resp?.data?.video_url || data.result?.video_url
    if (status === 'done') {
      if (videoUrl) return { status: 'completed', videoUrl }
      return { status: 'failed', error: '即梦任务完成但缺少 video_url' }
    }
    if (status === 'in_queue') return { status: 'pending' }
    if (status === 'generating' || status === 'processing') return { status: 'processing' }
    if (status === 'not_found' || status === 'expired') {
      return { status: 'failed', error: `即梦任务${status === 'expired' ? '已过期' : '不存在'}` }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const data = result?.data || {}
    return data.video_url || data.resp?.data?.video_url || data.result?.video_url || null
  }
}
