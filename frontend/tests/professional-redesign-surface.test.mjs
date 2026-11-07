import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const studioCss = read('app/assets/studio.css')
const indexPage = read('app/pages/index.vue')
const defaultLayout = read('app/layouts/default.vue')
const episodeWorkbench = read('app/views/drama/episode.vue')
const settingsPage = read('app/pages/settings.vue')
const dramaDetail = read('app/views/drama/detail.vue')

test('current theme exposes the production surface tokens', () => {
  assert.match(studioCss, /--surface-base:\s*#f7f8fa/)
  assert.match(studioCss, /--surface-raised:\s*#ffffff/)
  assert.match(studioCss, /--surface-muted:\s*#f7f8fa/)
  assert.match(studioCss, /--surface-outline:\s*#e7e9ee/)
  assert.match(studioCss, /--accent:\s*#f97316/)
})

test('project entry is a poster card grid', () => {
  assert.match(indexPage, /class="project-grid"/)
  assert.match(indexPage, /class="card project-card"/)
  assert.match(indexPage, /class="project-cover"/)
  assert.match(indexPage, /repeat\(auto-fill,\s*minmax\(240px,\s*1fr\)\)/)
})

test('global header uses frosted glass and settings has no legacy quick setup', () => {
  assert.match(defaultLayout, /backdrop-filter:\s*blur\(20px\)\s*saturate\(180%\)/)
  assert.match(defaultLayout, /border-bottom:\s*1px solid var\(--border\)/)
  assert.doesNotMatch(settingsPage, /Quick Setup/)
  assert.doesNotMatch(settingsPage, /官方推荐配置/)
  assert.doesNotMatch(settingsPage, /officialPresetCards/)
  assert.doesNotMatch(settingsPage, /quickTitle/)
})

test('workbench uses accent and success navigation states', () => {
  assert.match(episodeWorkbench, /icon-active/)
  assert.match(episodeWorkbench, /icon-done/)
  assert.match(episodeWorkbench, /sidebar-progress-seg/)
  assert.match(episodeWorkbench, /var\(--accent/)
  assert.match(episodeWorkbench, /var\(--success/)
  assert.doesNotMatch(dramaDetail, /rgba\(122,167,255/)
  assert.doesNotMatch(dramaDetail, /rgba\(76,125,255/)
})
