/**
 * Kling AI 新版视频生成 Adapter（API Key 鉴权）
 *
 * - 文生视频: POST /text-to-video/{model}
 * - 图生视频: POST /image-to-video/{model}
 * - 查询:     GET  /tasks?task_ids={id}
 *
 * 新版协议使用 Authorization: Bearer <API_KEY>；旧版 AccessKey/SecretKey JWT
 * 不在本适配器范围内。Kling 3.0 Turbo 目前仅支持首帧图，不支持首尾帧/多参考图。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'

const DEFAULT_BASE_URL = 'https://api-singapore.klingai.com'
const DEFAULT_MODEL = 'kling-3.0-turbo'
const DEFAULT_PROMPT_MAX = 3072
const I2V_PROMPT_MAX = 2500
const VALID_RATIOS = new Set(['16:9', '9:16', '1:1'])
const VALID_RESOLUTIONS = new Set(['720p', '1080p'])

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === 'string' && !!u.trim()) : []
  } catch {
    return []
  }
}

function baseUrl(config: AIConfig): string {
  return (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function errorMessage(result: any, fallback: string): string {
  const message = result?.message || result?.error?.message || fallback
  const code = result?.code ?? result?.error?.code
  return `${code != null ? `[${code}] ` : ''}${message}`
}

export class KlingVideoAdapter implements VideoProviderAdapter {
  provider = 'kling'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    if (!config.apiKey) throw new Error('Kling 未配置 API Key')

    const model = String(record.model || config.model || DEFAULT_MODEL).trim()
    if (!/^kling-[a-z0-9.-]+$/i.test(model)) {
      throw new Error(`Kling 模型名不合法：${model}`)
    }

    const prompt = String(record.prompt || '').trim()
    const firstFrame = String(record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = String(record.lastFrameUrl || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)

    if (refImages.length || refVideos.length || refAudios.length) {
      throw new Error('Kling 3.0 Turbo 暂不支持多参考图/参考视频/参考音频')
    }
    if (lastFrame) throw new Error('Kling 3.0 Turbo 暂不支持尾帧图')

    const duration = this.normalizeDuration(record.duration)
    const resolution = this.normalizeResolution(record.resolution)
    const options = {
      watermark_info: { enabled: record.watermark === true },
    }

    if (firstFrame) {
      if (!prompt) throw new Error('Kling 图生视频需要提示词')
      if (prompt.length > I2V_PROMPT_MAX) throw new Error(`Kling 图生视频提示词上限 ${I2V_PROMPT_MAX} 字符`)
      return {
        url: `${baseUrl(config)}/image-to-video/${encodeURIComponent(model)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: {
          contents: [
            { type: 'prompt', text: prompt },
            { type: 'first_frame', url: firstFrame },
          ],
          settings: { resolution, duration },
          options,
        },
      }
    }

    if (!prompt) throw new Error('Kling 文生视频需要提示词')
    if (prompt.length > DEFAULT_PROMPT_MAX) throw new Error(`Kling 文生视频提示词上限 ${DEFAULT_PROMPT_MAX} 字符`)

    return {
      url: `${baseUrl(config)}/text-to-video/${encodeURIComponent(model)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: {
        prompt,
        settings: {
          resolution,
          aspect_ratio: this.normalizeRatio(record.aspectRatio),
          duration,
        },
        options,
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result?.code !== 0 && result?.code !== undefined) {
      throw new Error(errorMessage(result, 'Kling 任务提交失败'))
    }
    const taskId = result?.data?.id
    if (taskId != null) return { isAsync: true, taskId: String(taskId) }
    throw new Error(errorMessage(result, 'Kling 响应中缺少 data.id'))
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: `${baseUrl(config)}/tasks?task_ids=${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    if (result?.code !== 0 && result?.code !== undefined) {
      return { status: 'failed', error: errorMessage(result, 'Kling 任务查询失败') }
    }
    const task = Array.isArray(result?.data) ? result.data[0] : result?.data
    if (!task) return { status: 'failed', error: 'Kling 任务查询响应为空' }

    const status = String(task.status || '')
    if (status === 'succeeded') {
      const output = (task.outputs || []).find((item: any) => item?.type === 'video')
      if (!output?.url) return { status: 'failed', error: 'Kling 任务成功但缺少视频 URL' }
      const duration = Number(output.duration)
      return {
        status: 'completed',
        videoUrl: output.url,
        ...(Number.isFinite(duration) ? { duration } : {}),
      }
    }
    if (status === 'failed') return { status: 'failed', error: task.message || 'Kling 视频生成失败' }
    if (status === 'submitted') return { status: 'pending' }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const task = Array.isArray(result?.data) ? result.data[0] : result?.data
    const output = (task?.outputs || []).find((item: any) => item?.type === 'video')
    return output?.url || null
  }

  private normalizeDuration(duration?: number | null): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    return Math.min(15, Math.max(3, parsed))
  }

  private normalizeResolution(resolution?: string | null): string {
    const value = String(resolution || '').toLowerCase()
    return VALID_RESOLUTIONS.has(value) ? value : '720p'
  }

  private normalizeRatio(ratio?: string | null): string {
    const value = String(ratio || '').trim()
    return VALID_RATIOS.has(value) ? value : '16:9'
  }
}
