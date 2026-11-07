import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const page = read('app/views/drama/episode.vue')
const useApi = read('app/composables/useApi.ts')

test('workbench offers model selectors for rewrite, image and video', () => {
  assert.match(page, /<ModelSelect/)
  assert.match(page, /v-model="chatModel"/)
  assert.match(page, /v-model="imageModel"/)
  assert.match(page, /v-model="videoModel"/)
  assert.match(page, /function collectModelOptions\(cfgs\)/)
  assert.match(page, /function ownerConfigId\(options, key\)/)
  assert.doesNotMatch(page, /<select v-model="chatModel"/)
})

test('model select is a custom popover component', () => {
  const component = read('app/components/ModelSelect.vue')
  const appMenu = read('app/components/AppMenu.vue')
  assert.match(component, /<AppMenu/)
  assert.match(component, /<AppMenuItem/)
  assert.match(component, /model-select-trigger/)
  assert.match(component, /emit\('update:modelValue', model\)/)
  assert.match(component, /showConfig/)
  assert.match(appMenu, /Teleport to="body"/)
  assert.match(appMenu, /class="app-menu"/)
})

test('image and video generation receive selected model and config', () => {
  assert.match(useApi, /generateImage: \(id: number, episodeId: number, model\?: string, configId\?: number, textModel\?: string, textConfigId\?: number\)/)
  assert.match(useApi, /text_model: textModel \|\| undefined/)
  assert.match(useApi, /text_config_id: textConfigId \|\| undefined/)
  assert.match(useApi, /config_id: configId \|\| undefined/)
  assert.match(page, /characterAPI\.generateImage\(/)
  assert.match(page, /imageModel\.value/)
  assert.match(page, /videoModel\.value/)
  assert.match(page, /ownerConfigId\(videoModelOptions\.value, videoModel\.value\)/)
})
