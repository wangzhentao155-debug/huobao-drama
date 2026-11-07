import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const detail = read('app/views/drama/detail.vue')
const useApi = read('app/composables/useApi.ts')

test('episode delete uses the unified confirm dialog and API', () => {
  assert.match(useApi, /episodeAPI = \{[\s\S]*?del: \(id: number\) => api\.del\(`\/episodes\/\$\{id\}`\)/)
  assert.match(detail, /class="btn btn-icon btn-sm ep-delete"/)
  assert.match(detail, /episodeToDelete = ep/)
  assert.match(detail, /<ConfirmDialog/)
  assert.match(detail, /episodeAPI\.del\(ep\.id\)/)
})

test('detail page exposes the asset library tab', () => {
  assert.match(detail, /detail\.tabs\.assets/)
  assert.match(detail, /activeTab === 'assets'/)
  assert.match(detail, /switchToAssets/)
  assert.match(detail, /assetGroups/)
})

test('episode status is manually marked, not derived from script content', () => {
  assert.match(detail, /const epStatusOptions = computed\(/)
  assert.match(detail, /function epStatus\(ep\) \{ return ep\.status \|\| 'draft' \}/)
  assert.match(detail, /function setEpisodeStatus/)
  assert.match(detail, /episodeAPI\.update\(ep\.id, \{ status \}\)/)
  assert.match(detail, /epStatusMenuId/)
  assert.doesNotMatch(detail, /已完成剧本/)
  assert.doesNotMatch(detail, /待编写/)
})

test('asset tab is sourced from characters, scenes and props', () => {
  assert.match(detail, /assetGroups/)
  assert.match(detail, /character/)
  assert.match(detail, /scene/)
  assert.match(detail, /prop/)
  assert.match(detail, /t\('detail\.assets\.emptyTitle'\)/)
})
