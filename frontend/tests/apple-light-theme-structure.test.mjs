import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const studioCss = read('../app/assets/studio.css')
const surfaces = [
  read('../app/pages/index.vue'),
  read('../app/views/drama/detail.vue'),
  read('../app/views/drama/episode.vue'),
  read('../app/pages/settings.vue'),
].join('\n')

test('light theme exposes the current ChatFire neutral and orange tokens', () => {
  assert.match(studioCss, /--surface-base:\s*#f7f8fa/i)
  assert.match(studioCss, /--surface-raised:\s*#ffffff/i)
  assert.match(studioCss, /--accent:\s*#f97316/i)
  assert.match(studioCss, /--success:\s*#16a34a/i)
  assert.match(studioCss, /--action-primary:\s*#f97316/i)
})

test('core surfaces no longer use the old graphite/film-console decoration', () => {
  assert.doesNotMatch(surfaces, /Noto Serif SC|film-strip|film-frame/i)
  assert.doesNotMatch(surfaces, /#15171a|#1c1f23|#20242a|#30343a/i)
  assert.doesNotMatch(surfaces, /#4c8dff|rgba\(76\s*,\s*141\s*,\s*255/i)
})
