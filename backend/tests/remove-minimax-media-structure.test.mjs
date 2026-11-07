import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

test('MiniMax image surfaces are removed while video stays supported', () => {
  const ai = read('backend/src/services/ai.ts')
  const registry = read('backend/src/services/adapters/registry.ts')

  // 图片能力已移除；视频能力（H3）保留
  assert.equal(exists('backend/src/services/adapters/minimax-image.ts'), false)
  assert.equal(exists('backend/src/services/adapters/minimax-video.ts'), true)
  assert.match(ai, /video: \[[^\]]*'minimax'/)
  assert.doesNotMatch(ai, /image: \[[^\]]*'minimax'/)
  assert.match(registry, /minimax: new MiniMaxVideoAdapter\(\)/)
})

test('AI config route only probes MiniMax as a video provider', () => {
  const route = read('backend/src/routes/aiConfigs.ts')
  assert.match(route, /if \(p === 'minimax'\) \{[\s\S]*?\/v2[\s\S]*?\/video_generation/)
})
