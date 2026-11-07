import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScript,
  checkScript,
  checkAssets,
  checkStoryboards,
  checkVideoPrompts,
  checkStyleLock,
  checkGenerationReceipts,
  checkMergeReceipt,
} from '../src/services/validators.js'

const goodScript = `## S01 | 内景 · 咖啡厅 | 黄昏
小明推门进来，手里攥着一张染血的纸，神情焦虑。
小明：（压低声音）你终于来了。
小红：（后退半步）东西带来了吗？

## S02 | 外景 · 街道 | 夜晚
小红转身离开，小明追到门口。
小明：（急促）等等，你还没回答我？
远处突然响起警笛声。`

test('parseScript extracts scenes and dialogue', () => {
  const parsed = parseScript(goodScript)
  assert.equal(parsed.scenes.length, 2)
  assert.equal(parsed.scenes[0].place, '咖啡厅')
  assert.equal(parsed.dialogue.length, 3)
  assert.equal(parsed.dialogue[0].speaker, '小明')
})

test('checkScript accepts a well-formed script and flags camera language', () => {
  const good = checkScript(goodScript)
  assert.equal(good.ok, true)
  assert.equal(good.errors, 0)

  const bad = checkScript('特写：小明走进来。他心里想，完了。')
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some(i => i.code === 'script.no-scene'))
  assert.ok(bad.issues.some(i => i.code === 'script.camera-language'))
  assert.ok(bad.issues.some(i => i.code === 'script.psychology'))
})

test('checkAssets validates anchors and extraction coverage', () => {
  const good = checkAssets({
    characters: [
      { id: 1, name: '小明', appearance: '二十出头，短发，瘦高，眼神疲惫，穿灰色夹克', styling: '深灰夹克，黑色长裤' },
      { id: 2, name: '小红', appearance: '同龄女性，长发，圆脸，穿浅色风衣，神情警惕', styling: '浅色风衣，帆布鞋' },
    ],
    scenes: [
      { id: 1, location: '咖啡厅', time: '黄昏', prompt: '临街咖啡厅，靠窗卡座，吧台在右侧，门口有风铃', lighting: '窗外夕阳侧光' },
      { id: 2, location: '街道', time: '夜晚', prompt: '旧街道路口，路灯昏黄，墙面斑驳，远处有警车灯光', lighting: '路灯顶光' },
    ],
    props: [{ id: 1, name: '染血纸条', description: '皱褶的白色纸条，边缘有暗红色血迹' }],
    episodeCharacterIds: [1, 2],
    episodeSceneIds: [1, 2],
    episodePropIds: [1],
    scriptSpeakers: ['小明', '小红'],
    scriptPlaces: ['咖啡厅', '街道'],
  })
  assert.equal(good.ok, true)

  const bad = checkAssets({
    characters: [{ id: 1, name: '小明', appearance: '', styling: '' }],
    scenes: [{ id: 1, location: '咖啡厅', time: '', prompt: '', lighting: '' }],
    props: [{ id: 1, name: '纸条', description: '' }],
    episodeCharacterIds: [1, 99],
    episodeSceneIds: [1],
    episodePropIds: [1],
    scriptSpeakers: ['小明', '小红'],
    scriptPlaces: ['咖啡厅', '街道'],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some(i => i.code === 'assets.character-link'))
  assert.ok(bad.issues.some(i => i.code === 'assets.character-appearance'))
  assert.ok(bad.issues.some(i => i.code === 'assets.scene-lighting'))
  assert.ok(bad.issues.some(i => i.code === 'assets.missing-speaker'))
})

test('checkStoryboards catches numbering, coverage and dialogue gaps', () => {
  const data = {
    shots: [
      { id: 1, number: 1, sceneId: 1, characterIds: [1], propIds: [], duration: 10, description: '小明进入咖啡厅，说：「你终于来了。」', shotType: '中景', angle: '平视', movement: '固定', videoPrompt: '0-3秒：x' },
      { id: 2, number: 2, sceneId: 2, characterIds: [2], propIds: [], duration: 10, description: '小红转身离开。', shotType: '全景', angle: '平视', movement: '固定', videoPrompt: '0-3秒：x' },
    ],
    episodeSceneIds: [1, 2],
    episodeCharacterIds: [1, 2],
    episodePropIds: [],
    scriptDialogueTexts: ['你终于来了。'],
    targetDurationSeconds: 20,
  }
  const good = checkStoryboards(data)
  assert.equal(good.ok, true)

  const bad = checkStoryboards({
    ...data,
    shots: [
      { ...data.shots[0], number: 1, sceneId: null, description: '' },
      { ...data.shots[1], number: 3, sceneId: 2 },
    ],
    episodeSceneIds: [1, 2, 3],
    scriptDialogueTexts: ['不存在的台词'],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some(i => i.code === 'storyboard.number-gap'))
  assert.ok(bad.issues.some(i => i.code === 'storyboard.scene-missing'))
  assert.ok(bad.issues.some(i => i.code === 'storyboard.scene-uncovered'))
})

test('checkVideoPrompts catches segment gaps, unknown refs and new dialogue', () => {
  const good = checkVideoPrompts({
    shots: [{
      id: 1,
      number: 1,
      duration: 6,
      videoPrompt: '出场人物：@小明、@小红；场景：@咖啡厅。\n0-3秒：中景，@小明 推门进入。\n3-6秒：近景，@小红 说：「你终于来了。」',
    }],
    allowedRefs: ['小明', '小红', '咖啡厅'],
    scriptDialogueTexts: ['你终于来了。'],
  })
  assert.equal(good.ok, true)

  const bad = checkVideoPrompts({
    shots: [{
      id: 1,
      number: 1,
      duration: 6,
      videoPrompt: '出场人物：@小明；场景：@咖啡厅。\n0-3秒：中景，@陌生人 出现。\n4-6秒：近景，@小红 说：「剧本里没有这句。」',
    }],
    allowedRefs: ['小明', '小红', '咖啡厅'],
    scriptDialogueTexts: ['你终于来了。'],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some(i => i.code === 'prompt.segment-gap'))
  assert.ok(bad.issues.some(i => i.code === 'prompt.ref-unknown'))
  assert.ok(bad.issues.some(i => i.code === 'prompt.dialogue-new'))
})

test('checkGenerationReceipts catches failed and missing receipts', () => {
  const good = checkGenerationReceipts({
    tasks: [{
      id: 1,
      type: 'video',
      status: 'completed',
      targetKey: 'video:storyboard:1',
      targetLabel: '镜头视频：S1',
      localPath: 'static/videos/task-1.mp4',
      localExists: true,
    }],
    expectations: [
      { key: 'video:storyboard:1', label: '镜头视频：S1', hasOutput: true },
      { key: 'video:storyboard:2', label: '镜头视频：S2', hasOutput: true },
    ],
  })
  assert.equal(good.ok, true)

  const bad = checkGenerationReceipts({
    tasks: [{
      id: 2,
      type: 'video',
      status: 'failed',
      targetKey: 'video:storyboard:2',
      targetLabel: '镜头视频：S2',
      errorMsg: 'content risk',
    }],
    expectations: [
      { key: 'video:storyboard:2', label: '镜头视频：S2', hasOutput: false },
      { key: 'video:storyboard:3', label: '镜头视频：S3', hasOutput: false },
    ],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some(i => i.code === 'generation.task-failed'))
  assert.ok(bad.issues.some(i => i.code === 'generation.not-generated'))
})

test('checkMergeReceipt validates completed merge and clip files', () => {
  const good = checkMergeReceipt({
    id: 1,
    status: 'completed',
    mergedUrl: 'static/videos/merge-1.mp4',
    mergedExists: true,
    clips: ['static/videos/task-1.mp4', 'static/videos/task-2.mp4'],
    clipsExist: [true, true],
    duration: 20,
    expectedDuration: 20,
    expectedClipCount: 2,
  })
  assert.equal(good.ok, true)

  const bad = checkMergeReceipt({
    id: 2,
    status: 'completed',
    mergedUrl: 'static/videos/merge-2.mp4',
    mergedExists: false,
    clips: ['static/videos/task-1.mp4'],
    clipsExist: [false],
    duration: 0,
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some(i => i.code === 'merge.file-missing'))
  assert.ok(bad.issues.some(i => i.code === 'merge.clip-missing'))

  const none = checkMergeReceipt(null)
  assert.equal(none.ok, true)
  assert.ok(none.issues.some(i => i.code === 'merge.not-run'))
})

test('checkStyleLock rejects template overrides and missing image anchor', () => {
  const good = checkStyleLock({
    styleKey: 'realistic',
    stylePrompt: 'cinematic realistic photography',
    templatePrompts: ['本模式强调生活化表演。'],
    imagePrompts: ['cinematic realistic photography, a character sheet'],
  })
  assert.equal(good.ok, true)

  const bad = checkStyleLock({
    styleKey: 'realistic',
    stylePrompt: 'cinematic realistic photography',
    templatePrompts: ['把画风改为冷色调赛博朋克'],
    imagePrompts: ['a character sheet without style'],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some(i => i.code === 'style.template-override'))
  assert.ok(bad.issues.some(i => i.code === 'style.image-missing-anchor'))
})
