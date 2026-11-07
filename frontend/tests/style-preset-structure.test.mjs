import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('settings page manages style presets in the base tab group', () => {
  const settings = read('app/pages/settings.vue')
  assert.match(settings, /settings\.tabs\.styles/)
  assert.match(settings, /Palette/)
  assert.match(settings, /stylePresetAPI/)
  assert.match(settings, /id: 'styles'/)
  assert.match(settings, /startAddStyle/)
  assert.match(settings, /startEditStyle/)
  assert.match(settings, /toggleStyle/)
  assert.match(settings, /confirmDelStyle/)
  assert.match(settings, /styleToDelete/)
  assert.match(settings, /<ConfirmDialog/)
})

test('useApi exposes style preset endpoints', () => {
  const useApi = read('app/composables/useApi.ts')
  assert.match(useApi, /export const stylePresetAPI/)
  assert.match(useApi, /\/style-presets/)
  assert.match(useApi, /\?all=1/)
  assert.match(useApi, /list: \(all = false\)/)
})
