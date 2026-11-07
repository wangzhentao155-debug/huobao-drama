import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const page = read('app/pages/index.vue')
const studioCss = read('app/assets/studio.css')

test('project list opens project detail before choosing an episode', () => {
  assert.match(page, /openDrama/)
  assert.match(page, /getDramaPath/)
  assert.match(page, /navigateTo\(getDramaPath\(d\)\)/)
  assert.match(page, /index\.openProject/)
})

test('project status is manually marked, not derived from content', () => {
  assert.match(page, /const statusOptions = computed\(/)
  assert.match(page, /function currentStatus\(d\) \{ return d\.status \|\| 'draft' \}/)
  assert.match(page, /function setDramaStatus/)
  assert.match(page, /dramaAPI\.update\(d\.id, \{ status \}\)/)
  assert.match(page, /statusMenuId/)
  assert.match(page, /statusFilter/)
  assert.doesNotMatch(page, /getProgress/)
})

test('project launcher keeps controls focused', () => {
  assert.match(page, /filteredDramas/)
  assert.match(page, /index\.createDialog\.title/)
  assert.doesNotMatch(page, /剧集列表/)
  assert.doesNotMatch(page, /制作队列/)
  assert.doesNotMatch(page, /最近活动/)
})

test('create dialog fixes aspect ratio and template at creation', () => {
  assert.match(page, /form\.aspect_ratio/)
  assert.match(page, /aspectRatioOptions/)
  assert.match(page, /index\.createDialog\.aspectRatio/)
  assert.match(page, /form\.template_id/)
  assert.doesNotMatch(page, /计划集数/)
})

test('global buttons use the current action palette', () => {
  assert.match(studioCss, /--action-primary:\s*#f97316/)
  assert.match(studioCss, /--action-secondary:\s*#e8eaee/)
  assert.match(studioCss, /--action-danger:\s*#dc2626/)
  assert.match(studioCss, /\.btn-primary\s*\{/)
})
