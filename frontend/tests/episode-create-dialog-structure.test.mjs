import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('episode create dialog asks for a title and fixed video resolution', () => {
  const page = read('app/views/drama/detail.vue')
  assert.doesNotMatch(page, /imageConfigs|videoConfigs/)
  assert.doesNotMatch(page, /配置将锁定/)
  assert.match(page, /newEpisodeTitle/)
  assert.match(page, /newEpisodeResolution/)
  assert.match(page, /const resolutionOptions = computed\(/)
  assert.match(page, /720p/)
  assert.match(page, /480p/)
  assert.match(page, /creatingEpisode/)
  assert.match(page, /detail\.epCreate\.create/)
})

test('addEpisode posts drama_id, title and resolution only', () => {
  const page = read('app/views/drama/detail.vue')
  const start = page.indexOf('async function addEpisode')
  const body = page.slice(start, page.indexOf('\n}', start) + 2)
  assert.match(body, /drama_id: dramaId/)
  assert.match(body, /title: newEpisodeTitle\.value/)
  assert.match(body, /resolution: newEpisodeResolution\.value/)
  assert.doesNotMatch(body, /image_config_id/)
  assert.doesNotMatch(body, /video_config_id/)
  assert.doesNotMatch(body, /aiConfigAPI/)
})

test('episode card resolution is editable and persisted', () => {
  const page = read('app/views/drama/detail.vue')
  assert.match(page, /epResolution/)
  assert.match(page, /setEpisodeResolution/)
  assert.match(page, /episodeAPI\.update\(ep\.id, \{ resolution \}\)/)
})

test('episode create dialog does not preload config lists', () => {
  const page = read('app/views/drama/detail.vue')
  assert.doesNotMatch(page, /loadConfigs/)
  assert.doesNotMatch(page, /aiConfigAPI\.list/)
  assert.doesNotMatch(page, /canCreateEpisode/)
})
