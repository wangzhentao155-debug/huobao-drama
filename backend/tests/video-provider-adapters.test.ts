import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KlingVideoAdapter } from '../src/services/adapters/kling-video.js'
import { JimengVideoAdapter } from '../src/services/adapters/jimeng-video.js'
import { LibTVVideoAdapter } from '../src/services/adapters/libtv-video.js'
import { videoAdapters } from '../src/services/adapters/registry.js'

const config = (provider: string, apiKey: string, model: string, baseUrl = '') => ({
  provider,
  apiKey,
  model,
  baseUrl,
})

test('Kling text-to-video builds new-standard request', () => {
  const adapter = new KlingVideoAdapter()
  const request = adapter.buildGenerateRequest(
    config('kling', 'kling-key', 'kling-3.0-turbo'),
    { id: 1, prompt: '雨夜追逐', duration: 5, aspectRatio: '9:16', resolution: '720p' },
  )
  assert.equal(request.url, 'https://api-singapore.klingai.com/text-to-video/kling-3.0-turbo')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer kling-key')
  assert.equal(request.body.prompt, '雨夜追逐')
  assert.equal(request.body.settings.aspect_ratio, '9:16')
  assert.equal(request.body.settings.duration, 5)
})

test('Kling image-to-video uses first_frame contents and rejects last frame', () => {
  const adapter = new KlingVideoAdapter()
  const request = adapter.buildGenerateRequest(
    config('kling', 'kling-key', 'kling-3.0-turbo'),
    { id: 2, prompt: '人物回头', firstFrameUrl: 'https://cdn.example/a.jpg' },
  )
  assert.equal(request.url, 'https://api-singapore.klingai.com/image-to-video/kling-3.0-turbo')
  assert.deepEqual(request.body.contents, [
    { type: 'prompt', text: '人物回头' },
    { type: 'first_frame', url: 'https://cdn.example/a.jpg' },
  ])
  assert.throws(() => adapter.buildGenerateRequest(
    config('kling', 'kling-key', 'kling-3.0-turbo'),
    { id: 3, prompt: 'x', firstFrameUrl: 'https://cdn.example/a.jpg', lastFrameUrl: 'https://cdn.example/b.jpg' },
  ), /尾帧/)
})

test('Kling polling extracts video output', () => {
  const adapter = new KlingVideoAdapter()
  const response = adapter.parsePollResponse({
    code: 0,
    data: [{
      id: 'task-1',
      status: 'succeeded',
      outputs: [{ type: 'video', url: 'https://cdn.example/out.mp4', duration: '5' }],
    }],
  })
  assert.equal(response.status, 'completed')
  assert.equal(response.videoUrl, 'https://cdn.example/out.mp4')
  assert.equal(response.duration, 5)
})

test('Jimeng text-to-video builds signed Visual API request', () => {
  const adapter = new JimengVideoAdapter()
  const request = adapter.buildGenerateRequest(
    config('jimeng', 'ak:sk', 'jimeng_t2v_v30_1080p'),
    { id: 4, prompt: '千军万马', duration: 5, aspectRatio: '16:9' },
  )
  assert.equal(request.url.startsWith('https://visual.volcengineapi.com/?'), true)
  assert.match(request.url, /Action=CVSync2AsyncSubmitTask/)
  assert.match(request.url, /Version=2022-08-31/)
  assert.match(String(request.headers.Authorization), /^HMAC-SHA256 Credential=ak\//)
  assert.match(String(request.headers['X-Date']), /^\d{8}T\d{6}Z$/)
  assert.equal(request.body.req_key, 'jimeng_t2v_v30_1080p')
  assert.equal(request.body.frames, 121)
})

test('Jimeng first/last-frame request uses tail req_key and two image urls', () => {
  const adapter = new JimengVideoAdapter()
  const request = adapter.buildGenerateRequest(
    config('jimeng', 'ak:sk', 'jimeng_i2v_first_tail_v30_1080'),
    {
      id: 5,
      prompt: '从白天到夜晚',
      firstFrameUrl: 'https://cdn.example/a.jpg',
      lastFrameUrl: 'https://cdn.example/b.jpg',
    },
  )
  assert.equal(request.body.req_key, 'jimeng_i2v_first_tail_v30_1080')
  assert.deepEqual(request.body.image_urls, ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'])
})

test('Jimeng polling handles done, generating and errors', () => {
  const adapter = new JimengVideoAdapter()
  assert.equal(adapter.parsePollResponse({ code: 10000, data: { status: 'done', video_url: 'https://x/v.mp4' } }).status, 'completed')
  assert.equal(adapter.parsePollResponse({ code: 10000, data: { status: 'generating' } }).status, 'processing')
  assert.equal(adapter.parsePollResponse({ code: 10000, data: { status: 'in_queue' } }).status, 'pending')
  assert.equal(adapter.parsePollResponse({ code: 20000, message: 'bad' }).status, 'failed')
})

test('Jimeng rejects malformed credentials', () => {
  const adapter = new JimengVideoAdapter()
  assert.throws(() => adapter.buildGenerateRequest(
    config('jimeng', 'not-a-pair', 'jimeng_t2v_v30_1080p'),
    { id: 6, prompt: 'x' },
  ), /AccessKey:SecretKey/)
})

test('LibTV creates session and extracts assistant video url', () => {
  const adapter = new LibTVVideoAdapter()
  const request = adapter.buildGenerateRequest(
    config('libtv', 'libtv-key', 'libtv'),
    { id: 7, prompt: '生一个古风视频', duration: 5 },
  )
  assert.equal(request.url, 'https://im.liblib.tv/openapi/session')
  assert.equal(request.headers.Authorization, 'Bearer libtv-key')
  assert.match(request.body.message, /生一个古风视频/)

  const submit = adapter.parseGenerateResponse({ data: { sessionId: 's-1', projectUuid: 'p-1' } })
  assert.deepEqual(submit, { isAsync: true, taskId: 's-1' })

  const poll = adapter.parsePollResponse({
    data: {
      messages: [
        { role: 'user', content: '生一个古风视频' },
        { role: 'assistant', content: [{ type: 'text', text: '生成完成 https://cdn.example/out.mp4' }] },
      ],
    },
  })
  assert.equal(poll.status, 'completed')
  assert.equal(poll.videoUrl, 'https://cdn.example/out.mp4')
})

test('new video adapters are registered', () => {
  assert.equal(videoAdapters.kling.provider, 'kling')
  assert.equal(videoAdapters.jimeng.provider, 'jimeng')
  assert.equal(videoAdapters.libtv.provider, 'libtv')
})
