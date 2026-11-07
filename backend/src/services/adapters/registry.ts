/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { OpenAIImageAdapter } from './openai-image'
import { GeminiImageAdapter } from './gemini-image'
import { VolcEngineImageAdapter } from './volcengine-image'
import { VolcEngineVideoAdapter } from './volcengine-video'
import { MiniMaxVideoAdapter } from './minimax-video'
import { AliyunWanVideoAdapter } from './aliyun-wan-video'
import { KlingVideoAdapter } from './kling-video'
import { JimengVideoAdapter } from './jimeng-video'
import { LibTVVideoAdapter } from './libtv-video'
import type { ImageProviderAdapter, VideoProviderAdapter } from './types'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  openai: new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  volcengine: new VolcEngineVideoAdapter(),
  minimax: new MiniMaxVideoAdapter(),
  aliyun: new AliyunWanVideoAdapter(),
  kling: new KlingVideoAdapter(),
  jimeng: new JimengVideoAdapter(),
  libtv: new LibTVVideoAdapter(),
}

/**
 * 获取图片 Adapter
 * @param provider 厂商名称；custom 时按 protocol 选择协议适配器
 * @returns 对应的 Adapter
 */
export function getImageAdapter(provider: string, protocol?: string | null): ImageProviderAdapter {
  const key = provider.toLowerCase() === 'custom'
    ? (protocol || '').toLowerCase()
    : provider.toLowerCase()
  const adapter = imageAdapters[key]
  if (!adapter) {
    throw new Error(provider.toLowerCase() === 'custom'
      ? `自定义图片协议未选择或不受支持：${protocol || '(空)'}`
      : `Unsupported image provider: ${provider}`)
  }
  return adapter
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称；custom 时按 protocol 选择协议适配器
 * @returns 对应的 Adapter
 */
export function getVideoAdapter(provider: string, protocol?: string | null): VideoProviderAdapter {
  const key = provider.toLowerCase() === 'custom'
    ? (protocol || '').toLowerCase()
    : provider.toLowerCase()
  const adapter = videoAdapters[key]
  if (!adapter) {
    throw new Error(provider.toLowerCase() === 'custom'
      ? `自定义视频协议未选择或不受支持：${protocol || '(空)'}`
      : `Unsupported video provider: ${provider}`)
  }
  return adapter
}
