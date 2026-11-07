/**
 * V1–V5 确定性校验器
 *
 * V1 剧本契约：场景头、对白、钩子、可拍性
 * V2 资产账本：角色母版、场景锚点、道具、提取覆盖
 * V3 分镜契约：镜号、场景/角色绑定、时长、对白覆盖
 * V4 提示词契约：信息头、3 秒分段、@引用、逐字台词
 * V5 风格锁：项目风格存在、模板不得覆盖、生图提示词包含风格锚点
 *
 * 校验器不调用模型；只读数据库/纯文本，返回结构化错误与警告。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { getDramaStylePrompt } from './style-preset.js'
import { resolveModeContext } from './mode-context.js'

export type ValidatorId = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7'
export type Severity = 'error' | 'warning'

export interface ValidationIssue {
  code: string
  severity: Severity
  message: string
  field?: string
  ref?: string | number
}

export interface ValidatorResult {
  id: ValidatorId
  name: string
  ok: boolean
  errors: number
  warnings: number
  issues: ValidationIssue[]
  meta?: Record<string, unknown>
}

export interface ValidationReport {
  episodeId: number
  dramaId: number
  ok: boolean
  errors: number
  warnings: number
  generatedAt: string
  results: ValidatorResult[]
}

export interface ScriptScene {
  number: string
  header: string
  rawLocation: string
  place: string
  time: string
  line: number
}

export interface ScriptDialogue {
  speaker: string
  text: string
  raw: string
  line: number
}

export interface ParsedScript {
  text: string
  scenes: ScriptScene[]
  dialogue: ScriptDialogue[]
}

const SCENE_HEADER_RE = /^##\s*(S\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/
const DIALOGUE_RE = /^([^\s：:（(【\[]{1,20})[：:]\s*(?:[（(][^）)]*[）)]\s*)?(.+)$/
const NARRATION_SPEAKERS = new Set(['旁白', '画外音', '系统', '字幕'])
const STRUCTURAL_SPEAKER_RE = /^(第\s*\d+\s*集|片名|剧名|屏幕|标题|字幕|画面|场景|地点|时间|备注)/
const CAMERA_WORDS_RE = /特写|近景|中景|远景|全景|推镜|拉镜|摇镜|移镜|跟镜|镜头/
const PSYCHOLOGY_RE = /心里想|心想|内心/
const HOOK_RE = /？|！|突然|却|竟|没想到|电话|敲门|血|死|离婚|裁员|分手|报警|失踪|发现|秘密|威胁|选择/
const STYLE_OVERRIDE_RE = /画风改为|风格改为|画风切换|风格切换|覆盖.{0,6}风格|不要使用.{0,6}风格|冷色调|暖色调|胶片颗粒|赛博朋克|水墨风|厚涂/

export function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[，。；：！？、,.!?;:""''「」『』（）()]/g, '')
    .toLowerCase()
}

function normalizeName(value: string | null | undefined): string {
  return String(value || '')
    .replace(/[（(][^（()）]*[）)]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function issue(code: string, severity: Severity, message: string, extra: Partial<ValidationIssue> = {}): ValidationIssue {
  return { code, severity, message, ...extra }
}

export function parseScript(text: string | null | undefined): ParsedScript {
  const source = String(text || '')
  const scenes: ScriptScene[] = []
  const dialogue: ScriptDialogue[] = []
  const lines = source.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const scene = line.match(SCENE_HEADER_RE)
    if (scene) {
      const rawLocation = scene[2].trim()
      const place = rawLocation.includes('·')
        ? rawLocation.split('·').slice(1).join('·').trim()
        : rawLocation.replace(/^(内景|外景)\s*/g, '').trim()
      scenes.push({
        number: scene[1],
        header: line,
        rawLocation,
        place,
        time: scene[3].trim(),
        line: i + 1,
      })
      continue
    }

    if (/^#{1,6}\s/.test(line) || /^[【\[]/.test(line)) continue
    const d = line.match(DIALOGUE_RE)
    if (d && d[2].trim() && !STRUCTURAL_SPEAKER_RE.test(d[1].trim())) {
      dialogue.push({
        speaker: d[1].trim(),
        text: d[2].trim(),
        raw: line,
        line: i + 1,
      })
    }
  }

  return { text: source, scenes, dialogue }
}

// ─── V1 剧本契约 ────────────────────────────────────────

export function checkScript(text: string | null | undefined): ValidatorResult {
  const parsed = parseScript(text)
  const issues: ValidationIssue[] = []
  const source = parsed.text.trim()

  if (!source) {
    issues.push(issue('script.empty', 'error', '剧本为空', { field: 'scriptContent' }))
  } else {
    if (source.length < 400) {
      issues.push(issue('script.too-short', 'warning', `剧本仅 ${source.length} 字，可能不足以支撑一集`, { field: 'scriptContent' }))
    }
    if (!parsed.scenes.length) {
      issues.push(issue('script.no-scene', 'error', '未识别到场景头（## S01 | 内景 · 地点 | 时间段）', { field: 'scriptContent' }))
    }
    if (!parsed.dialogue.length) {
      issues.push(issue('script.no-dialogue', 'warning', '未识别到对白，短剧通常需要台词推进', { field: 'scriptContent' }))
    }

    let previous = 0
    for (const scene of parsed.scenes) {
      if (!/^(内景|外景)/.test(scene.rawLocation) || !scene.rawLocation.includes('·')) {
        issues.push(issue('script.scene-header', 'warning', `场景头格式不完整：${scene.header}`, { field: 'scriptContent', ref: scene.number }))
      }
      const number = Number(scene.number.replace(/^S/i, ''))
      if (Number.isFinite(number) && number <= previous) {
        issues.push(issue('script.scene-order', 'warning', `场景编号未递增：${scene.number}`, { field: 'scriptContent', ref: scene.number }))
      }
      if (Number.isFinite(number)) previous = number
    }

    if (CAMERA_WORDS_RE.test(source)) {
      issues.push(issue('script.camera-language', 'warning', '剧本中出现镜头语言（景别/运镜），应留给分镜阶段', { field: 'scriptContent' }))
    }
    if (PSYCHOLOGY_RE.test(source)) {
      issues.push(issue('script.psychology', 'warning', '剧本中出现心理描写，应转成可见表情/动作/对白', { field: 'scriptContent' }))
    }

    const first = source.slice(0, 120)
    if (!HOOK_RE.test(first)) {
      issues.push(issue('script.opening-hook', 'warning', '前 120 字未见明显冲突、异常或强信息钩子', { field: 'scriptContent' }))
    }
    const last = source.slice(-220)
    if (!HOOK_RE.test(last)) {
      issues.push(issue('script.ending-hook', 'warning', '结尾 220 字未见明显悬念、威胁或选择钩子', { field: 'scriptContent' }))
    }
  }

  return buildResult('V1', '剧本契约', issues, {
    scenes: parsed.scenes.length,
    dialogue: parsed.dialogue.length,
    words: source.length,
  })
}

// ─── V2 资产账本 ────────────────────────────────────────

export interface AssetCharacter {
  id: number
  name: string
  appearance?: string | null
  styling?: string | null
}
export interface AssetScene {
  id: number
  location: string
  time?: string | null
  prompt?: string | null
  lighting?: string | null
}
export interface AssetProp {
  id: number
  name: string
  description?: string | null
}
export interface AssetCheckInput {
  characters: AssetCharacter[]
  scenes: AssetScene[]
  props: AssetProp[]
  episodeCharacterIds: number[]
  episodeSceneIds: number[]
  episodePropIds: number[]
  scriptSpeakers: string[]
  scriptPlaces: string[]
}

export function checkAssets(input: AssetCheckInput): ValidatorResult {
  const issues: ValidationIssue[] = []
  const characterIds = new Set(input.characters.map(c => c.id))
  const sceneIds = new Set(input.scenes.map(s => s.id))
  const propIds = new Set(input.props.map(p => p.id))
  const episodeCharacters = input.characters.filter(c => input.episodeCharacterIds.includes(c.id))
  const episodeScenes = input.scenes.filter(s => input.episodeSceneIds.includes(s.id))
  const episodeProps = input.props.filter(p => input.episodePropIds.includes(p.id))

  if (!input.episodeCharacterIds.length) issues.push(issue('assets.no-characters', 'error', '本集没有关联角色', { field: 'characters' }))
  if (!input.episodeSceneIds.length) issues.push(issue('assets.no-scenes', 'error', '本集没有关联场景', { field: 'scenes' }))
  if (input.episodePropIds.length > 3) issues.push(issue('assets.too-many-props', 'warning', `本集道具 ${input.episodePropIds.length} 个，建议不超过 3 个`, { field: 'props' }))

  for (const id of input.episodeCharacterIds) {
    if (!characterIds.has(id)) issues.push(issue('assets.character-link', 'error', `本集关联了不存在的角色 ID：${id}`, { field: 'characters', ref: id }))
  }
  for (const id of input.episodeSceneIds) {
    if (!sceneIds.has(id)) issues.push(issue('assets.scene-link', 'error', `本集关联了不存在的场景 ID：${id}`, { field: 'scenes', ref: id }))
  }
  for (const id of input.episodePropIds) {
    if (!propIds.has(id)) issues.push(issue('assets.prop-link', 'error', `本集关联了不存在的道具 ID：${id}`, { field: 'props', ref: id }))
  }

  const charNames = new Map<string, number>()
  for (const c of episodeCharacters) {
    const key = normalizeName(c.name)
    charNames.set(key, (charNames.get(key) || 0) + 1)
    if (!c.name.trim()) issues.push(issue('assets.character-name', 'error', '角色缺少名称', { field: 'characters', ref: c.id }))
    if ((c.appearance || '').trim().length < 20) issues.push(issue('assets.character-appearance', 'error', `角色「${c.name}」样貌锚点过短或缺失`, { field: 'characters', ref: c.id }))
    if ((c.styling || '').trim().length < 6) issues.push(issue('assets.character-styling', 'error', `角色「${c.name}」妆造锚点过短或缺失`, { field: 'characters', ref: c.id }))
  }
  for (const [name, count] of charNames) {
    if (count > 1 && name) issues.push(issue('assets.character-duplicate', 'error', `角色名称重复：${name}`, { field: 'characters' }))
  }

  const sceneKeys = new Set<string>()
  for (const s of episodeScenes) {
    const key = `${normalizeName(s.location)}@${normalizeName(s.time)}`
    if (sceneKeys.has(key)) issues.push(issue('assets.scene-duplicate', 'error', `场景重复：${s.location} / ${s.time || '未写时间'}`, { field: 'scenes', ref: s.id }))
    sceneKeys.add(key)
    if (!s.location.trim()) issues.push(issue('assets.scene-location', 'error', '场景缺少地点', { field: 'scenes', ref: s.id }))
    if (!(s.time || '').trim()) issues.push(issue('assets.scene-time', 'error', `场景「${s.location}」缺少时间段`, { field: 'scenes', ref: s.id }))
    if ((s.prompt || '').trim().length < 20) issues.push(issue('assets.scene-prompt', 'error', `场景「${s.location}」空间描述过短或缺失`, { field: 'scenes', ref: s.id }))
    if ((s.lighting || '').trim().length < 4) issues.push(issue('assets.scene-lighting', 'error', `场景「${s.location}」缺少固有光源`, { field: 'scenes', ref: s.id }))
  }

  for (const p of episodeProps) {
    if (!p.name.trim()) issues.push(issue('assets.prop-name', 'error', '道具缺少名称', { field: 'props', ref: p.id }))
    if ((p.description || '').trim().length < 6) issues.push(issue('assets.prop-description', 'error', `道具「${p.name}」外观描述过短或缺失`, { field: 'props', ref: p.id }))
  }

  const speakers = input.scriptSpeakers
    .map(s => s.trim())
    .filter(s => s && !NARRATION_SPEAKERS.has(s))
  for (const speaker of new Set(speakers)) {
    if (!episodeCharacters.some(c => normalizeName(c.name) === normalizeName(speaker))) {
      issues.push(issue('assets.missing-speaker', 'warning', `剧本说话人未提取为角色：${speaker}`, { field: 'characters' }))
    }
  }

  for (const place of new Set(input.scriptPlaces.map(p => p.trim()).filter(Boolean))) {
    if (!episodeScenes.some(s => normalizeName(s.location).includes(normalizeName(place)) || normalizeName(place).includes(normalizeName(s.location)))) {
      issues.push(issue('assets.missing-scene', 'warning', `剧本场景未提取：${place}`, { field: 'scenes' }))
    }
  }

  return buildResult('V2', '资产账本', issues, {
    characters: input.episodeCharacterIds.length,
    scenes: input.episodeSceneIds.length,
    props: input.episodePropIds.length,
  })
}

// ─── V3 分镜契约 ────────────────────────────────────────

export interface StoryboardShot {
  id: number
  number: number
  sceneId: number | null
  characterIds: number[]
  propIds: number[]
  duration: number
  description?: string | null
  shotType?: string | null
  angle?: string | null
  movement?: string | null
  videoPrompt?: string | null
}
export interface StoryboardCheckInput {
  shots: StoryboardShot[]
  episodeSceneIds: number[]
  episodeCharacterIds: number[]
  episodePropIds: number[]
  scriptDialogueTexts: string[]
  targetDurationSeconds: number
}

export function checkStoryboards(input: StoryboardCheckInput): ValidatorResult {
  const issues: ValidationIssue[] = []
  const shots = [...input.shots].sort((a, b) => a.number - b.number)
  const sceneIds = new Set(input.episodeSceneIds)
  const characterIds = new Set(input.episodeCharacterIds)
  const propIds = new Set(input.episodePropIds)

  if (!shots.length) {
    issues.push(issue('storyboard.empty', 'error', '本集没有分镜', { field: 'storyboards' }))
    return buildResult('V3', '分镜契约', issues, { shots: 0 })
  }

  const numbers = new Set<number>()
  let expected = 1
  for (const shot of shots) {
    if (numbers.has(shot.number)) issues.push(issue('storyboard.number-duplicate', 'error', `分镜号重复：${shot.number}`, { field: 'storyboards', ref: shot.number }))
    numbers.add(shot.number)
    if (shot.number !== expected) issues.push(issue('storyboard.number-gap', 'error', `分镜号不连续：期望 ${expected}，实际 ${shot.number}`, { field: 'storyboards', ref: shot.number }))
    expected = shot.number + 1

    if (shot.sceneId == null) issues.push(issue('storyboard.scene-missing', 'error', `分镜 #${shot.number} 未绑定场景`, { field: 'sceneId', ref: shot.id }))
    else if (!sceneIds.has(shot.sceneId)) issues.push(issue('storyboard.scene-invalid', 'error', `分镜 #${shot.number} 场景 ID 无效：${shot.sceneId}`, { field: 'sceneId', ref: shot.id }))
    for (const id of shot.characterIds) {
      if (!characterIds.has(id)) issues.push(issue('storyboard.character-invalid', 'error', `分镜 #${shot.number} 角色 ID 无效：${id}`, { field: 'characterIds', ref: shot.id }))
    }
    for (const id of shot.propIds) {
      if (!propIds.has(id)) issues.push(issue('storyboard.prop-invalid', 'error', `分镜 #${shot.number} 道具 ID 无效：${id}`, { field: 'propIds', ref: shot.id }))
    }

    if (!Number.isInteger(shot.duration) || shot.duration <= 0) {
      issues.push(issue('storyboard.duration', 'error', `分镜 #${shot.number} 时长必须是正整数`, { field: 'duration', ref: shot.id }))
    } else if (shot.duration < 3 || shot.duration > 15) {
      issues.push(issue('storyboard.duration-range', 'warning', `分镜 #${shot.number} 时长 ${shot.duration}s 超出常见 3–15s 范围`, { field: 'duration', ref: shot.id }))
    }
    if (!(shot.description || '').trim()) issues.push(issue('storyboard.description', 'error', `分镜 #${shot.number} 缺少画面描述`, { field: 'description', ref: shot.id }))
    if (!(shot.shotType || '').trim()) issues.push(issue('storyboard.shot-type', 'warning', `分镜 #${shot.number} 缺少景别`, { field: 'shotType', ref: shot.id }))
    if (!(shot.angle || '').trim()) issues.push(issue('storyboard.angle', 'warning', `分镜 #${shot.number} 缺少机位角度`, { field: 'angle', ref: shot.id }))
    if (!(shot.movement || '').trim()) issues.push(issue('storyboard.movement', 'warning', `分镜 #${shot.number} 缺少运镜`, { field: 'movement', ref: shot.id }))
    if (!(shot.videoPrompt || '').trim()) issues.push(issue('storyboard.video-prompt', 'warning', `分镜 #${shot.number} 缺少 video_prompt`, { field: 'videoPrompt', ref: shot.id }))
  }

  for (const sceneId of input.episodeSceneIds) {
    if (!shots.some(s => s.sceneId === sceneId)) {
      issues.push(issue('storyboard.scene-uncovered', 'error', `场景 ID ${sceneId} 没有任何分镜覆盖`, { field: 'sceneId' }))
    }
  }

  const descriptions = shots.map(s => normalizeText(`${s.description || ''}\n${s.videoPrompt || ''}`)).join('\n')
  for (const dialogue of input.scriptDialogueTexts) {
    const cleaned = dialogue.replace(/[（(][^）)]*[）)]/g, '')
    const parts = cleaned.split(/[。！？!?]/).map(normalizeText).filter(part => part.length >= 4)
    for (const part of parts) {
      if (!descriptions.includes(part)) {
        issues.push(issue('storyboard.dialogue-missing', 'warning', `剧本台词未在分镜描述中找到：${part.slice(0, 30)}`, { field: 'description' }))
      }
    }
  }

  const totalDuration = shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0)
  if (input.targetDurationSeconds > 0) {
    const deviation = Math.abs(totalDuration - input.targetDurationSeconds) / input.targetDurationSeconds
    if (deviation > 0.3) {
      issues.push(issue('storyboard.duration-total', 'warning', `分镜总时长 ${totalDuration}s，与目标 ${Math.round(input.targetDurationSeconds)}s 偏差 ${Math.round(deviation * 100)}%`, { field: 'duration' }))
    }
  }

  return buildResult('V3', '分镜契约', issues, {
    shots: shots.length,
    totalDuration,
    targetDuration: Math.round(input.targetDurationSeconds),
  })
}

// ─── V4 提示词契约 ──────────────────────────────────────

export interface PromptCheckInput {
  shots: Array<{ id: number; number: number; duration: number; videoPrompt?: string | null }>
  allowedRefs: string[]
  scriptDialogueTexts: string[]
}

export function checkVideoPrompts(input: PromptCheckInput): ValidatorResult {
  const issues: ValidationIssue[] = []
  if (!input.shots.length) {
    issues.push(issue('prompt.no-shots', 'error', '本集没有分镜，无法校验提示词', { field: 'storyboards' }))
    return buildResult('V4', '提示词契约', issues, { prompts: 0 })
  }

  const allowed = new Set(input.allowedRefs.map(normalizeName).filter(Boolean))
  const dialogueSet = new Set(input.scriptDialogueTexts.map(normalizeText).filter(Boolean))
  let promptCount = 0

  for (const shot of input.shots) {
    const prompt = String(shot.videoPrompt || '').trim()
    if (!prompt) {
      issues.push(issue('prompt.empty', 'error', `分镜 #${shot.number} 没有 video_prompt`, { field: 'videoPrompt', ref: shot.id }))
      continue
    }
    promptCount++

    const firstLine = prompt.split(/\r?\n/).find(line => line.trim()) || ''
    if (!/^(?:出场人物|人物)[：:]/.test(firstLine) && !firstLine.includes('场景')) {
      issues.push(issue('prompt.header', 'warning', `分镜 #${shot.number} 首行缺少人物/场景信息头`, { field: 'videoPrompt', ref: shot.id }))
    }
    if (!/@/.test(firstLine)) {
      issues.push(issue('prompt.header-ref', 'warning', `分镜 #${shot.number} 信息头没有 @引用`, { field: 'videoPrompt', ref: shot.id }))
    }

    const segments: Array<{ start: number; end: number }> = []
    const segmentRe = /^\s*(\d+)\s*[-–]\s*(\d+)\s*秒\s*[:：]/gm
    let match: RegExpExecArray | null
    while ((match = segmentRe.exec(prompt))) {
      segments.push({ start: Number(match[1]), end: Number(match[2]) })
    }
    if (!segments.length) {
      issues.push(issue('prompt.segments', 'error', `分镜 #${shot.number} 没有按 3 秒分段`, { field: 'videoPrompt', ref: shot.id }))
    } else {
      if (segments[0].start !== 0) issues.push(issue('prompt.segment-start', 'error', `分镜 #${shot.number} 首段不是从 0 秒开始`, { field: 'videoPrompt', ref: shot.id }))
      for (let i = 1; i < segments.length; i++) {
        if (segments[i].start !== segments[i - 1].end) {
          issues.push(issue('prompt.segment-gap', 'error', `分镜 #${shot.number} 时间段不连续：${segments[i - 1].end}→${segments[i].start}`, { field: 'videoPrompt', ref: shot.id }))
        }
      }
      const last = segments[segments.length - 1].end
      if (shot.duration > 0 && (last > shot.duration + 1 || last < shot.duration - 2)) {
        issues.push(issue('prompt.segment-duration', 'warning', `分镜 #${shot.number} 时间段结束 ${last}s，分镜时长 ${shot.duration}s`, { field: 'videoPrompt', ref: shot.id }))
      }
    }

    const refRe = /@([^\s，。；、,:：]+)/g
    const seenRefs = new Set<string>()
    while ((match = refRe.exec(prompt))) {
      const raw = match[1].replace(/^图片\d+/, '').trim()
      if (!raw || seenRefs.has(raw)) continue
      seenRefs.add(raw)
      if (!allowed.has(normalizeName(raw))) {
        issues.push(issue('prompt.ref-unknown', 'error', `分镜 #${shot.number} 引用了未知名字：@${raw}`, { field: 'videoPrompt', ref: shot.id }))
      }
    }

    const quoteRe = /([^\s：:]{1,20})\s*说[：:]\s*[「“"]([^」”"]+)[」”"]/g
    while ((match = quoteRe.exec(prompt))) {
      const text = match[2].trim()
      const normalizedQuote = normalizeText(text)
      const matched = !dialogueSet.size || [...dialogueSet].some(dialogue =>
        dialogue === normalizedQuote || dialogue.includes(normalizedQuote) || normalizedQuote.includes(dialogue))
      if (text && !matched) {
        issues.push(issue('prompt.dialogue-new', 'error', `分镜 #${shot.number} 出现剧本外台词：${text.slice(0, 30)}`, { field: 'videoPrompt', ref: shot.id }))
      }
    }

    if (prompt.length > 8000) {
      issues.push(issue('prompt.too-long', 'warning', `分镜 #${shot.number} 提示词 ${prompt.length} 字，可能超出模型上限`, { field: 'videoPrompt', ref: shot.id }))
    }
  }

  return buildResult('V4', '提示词契约', issues, { prompts: promptCount })
}

// ─── V5 风格锁 ──────────────────────────────────────────

export interface StyleCheckInput {
  styleKey: string
  stylePrompt: string
  templatePrompts: string[]
  imagePrompts: string[]
}

export function checkStyleLock(input: StyleCheckInput): ValidatorResult {
  const issues: ValidationIssue[] = []
  if (!input.styleKey) issues.push(issue('style.missing-key', 'error', '项目没有绑定视觉风格', { field: 'style' }))
  if (!input.stylePrompt) issues.push(issue('style.missing-prompt', 'error', `风格预设「${input.styleKey || '空'}」没有可用提示词`, { field: 'style' }))

  for (const prompt of input.templatePrompts) {
    const match = prompt.match(STYLE_OVERRIDE_RE)
    if (match) {
      issues.push(issue('style.template-override', 'error', `模板/技能中出现风格覆盖指令：${match[0]}`, { field: 'agent_prompts' }))
    }
  }

  if (input.stylePrompt) {
    for (const prompt of input.imagePrompts) {
      if (!prompt.trim()) continue
      if (!prompt.trim().startsWith(input.stylePrompt.trim())) {
        issues.push(issue('style.image-missing-anchor', 'error', '生图提示词没有以项目风格锚点开头', { field: 'finalPrompt' }))
      }
    }
    if (!input.imagePrompts.length) {
      issues.push(issue('style.no-image-prompts', 'warning', '尚无生图提示词可做风格锚点校验', { field: 'finalPrompt' }))
    }
  }

  const styleHash = crypto.createHash('sha1').update(`${input.styleKey}|${input.stylePrompt}`).digest('hex').slice(0, 16)
  return buildResult('V5', '风格锁', issues, { styleKey: input.styleKey, styleHash })
}

// ─── V6 生成回执 ────────────────────────────────────────

export interface GenerationReceiptTask {
  id: number
  type: string
  status: string
  targetKey: string
  targetLabel: string
  localPath?: string | null
  resultUrl?: string | null
  localExists?: boolean
  errorMsg?: string | null
}
export interface GenerationExpectation {
  key: string
  label: string
  hasOutput: boolean
}
export interface GenerationCheckInput {
  tasks: GenerationReceiptTask[]
  expectations: GenerationExpectation[]
}

export function checkGenerationReceipts(input: GenerationCheckInput): ValidatorResult {
  const issues: ValidationIssue[] = []
  const completed = new Set(input.tasks.filter(task => task.status === 'completed').map(task => task.targetKey))
  const failed = new Set<string>()

  for (const task of input.tasks) {
    if (task.status === 'completed') {
      if (task.localPath && task.localExists === false) {
        issues.push(issue('generation.file-missing', 'error', `${task.targetLabel} 的回执文件不存在：${task.localPath}`, { field: 'localPath', ref: task.id }))
      } else if (!task.localPath && !task.resultUrl) {
        issues.push(issue('generation.receipt-empty', 'error', `${task.targetLabel} 已完成但缺少结果地址和本地文件`, { field: 'resultUrl', ref: task.id }))
      } else if (!task.localPath && task.resultUrl) {
        issues.push(issue('generation.remote-only', 'warning', `${task.targetLabel} 只有上游地址，尚未落盘`, { field: 'localPath', ref: task.id }))
      }
      continue
    }

    if (task.status === 'failed') {
      failed.add(task.targetKey)
      if (!completed.has(task.targetKey)) {
        issues.push(issue('generation.task-failed', 'error', `${task.targetLabel} 生成失败：${task.errorMsg || '未知错误'}`, { field: 'status', ref: task.id }))
      }
      continue
    }

    if (!completed.has(task.targetKey)) {
      issues.push(issue('generation.task-processing', 'warning', `${task.targetLabel} 任务仍在处理中`, { field: 'status', ref: task.id }))
    }
  }

  for (const expectation of input.expectations) {
    if (expectation.hasOutput || completed.has(expectation.key) || failed.has(expectation.key)) continue
    issues.push(issue('generation.not-generated', 'warning', `${expectation.label} 尚未生成`, { field: 'output' }))
  }

  return buildResult('V6', '生成回执', issues, {
    tasks: input.tasks.length,
    completed: completed.size,
    expectations: input.expectations.length,
  })
}

// ─── V7 合成回执 ────────────────────────────────────────

export interface MergeReceipt {
  id: number
  status: string
  mergedUrl?: string | null
  mergedExists?: boolean
  clips?: string[]
  clipsExist?: boolean[]
  duration?: number | null
  expectedDuration?: number
  expectedClipCount?: number
  errorMsg?: string | null
}

export function checkMergeReceipt(merge: MergeReceipt | null | undefined): ValidatorResult {
  const issues: ValidationIssue[] = []
  if (!merge) {
    issues.push(issue('merge.not-run', 'warning', '该集尚未执行合成', { field: 'videoMerges' }))
    return buildResult('V7', '合成回执', issues, { mergeId: null })
  }

  if (merge.status === 'failed') {
    issues.push(issue('merge.failed', 'error', `合成失败：${merge.errorMsg || '未知错误'}`, { field: 'status', ref: merge.id }))
    return buildResult('V7', '合成回执', issues, { mergeId: merge.id })
  }
  if (merge.status !== 'completed') {
    issues.push(issue('merge.processing', 'warning', '合成任务仍在处理中', { field: 'status', ref: merge.id }))
    return buildResult('V7', '合成回执', issues, { mergeId: merge.id })
  }

  if (!merge.mergedUrl) {
    issues.push(issue('merge.no-output', 'error', '合成完成但缺少成片地址', { field: 'mergedUrl', ref: merge.id }))
  } else if (merge.mergedExists === false) {
    issues.push(issue('merge.file-missing', 'error', '合成成片文件不存在', { field: 'mergedUrl', ref: merge.id }))
  }

  const clips = merge.clips || []
  if (!clips.length) {
    issues.push(issue('merge.no-clips', 'error', '合成记录没有包含任何镜头', { field: 'scenes', ref: merge.id }))
  }
  const missingClips = clips.filter((_, index) => merge.clipsExist?.[index] === false)
  if (missingClips.length) {
    issues.push(issue('merge.clip-missing', 'error', `${missingClips.length} 个参与合成的镜头文件不存在`, { field: 'scenes', ref: merge.id }))
  }

  if (!merge.duration || merge.duration <= 0) {
    issues.push(issue('merge.duration', 'warning', '合成成片时长为 0 或缺失', { field: 'duration', ref: merge.id }))
  } else if (
    merge.expectedDuration && merge.expectedDuration > 0 &&
    merge.expectedClipCount && clips.length === merge.expectedClipCount
  ) {
    const deviation = Math.abs(merge.duration - merge.expectedDuration) / merge.expectedDuration
    if (deviation > 0.1) {
      issues.push(issue('merge.duration-mismatch', 'warning', `成片时长 ${merge.duration}s 与镜头总时长 ${merge.expectedDuration}s 偏差 ${Math.round(deviation * 100)}%`, { field: 'duration', ref: merge.id }))
    }
  }

  return buildResult('V7', '合成回执', issues, {
    mergeId: merge.id,
    clips: clips.length,
    duration: merge.duration,
  })
}

function buildResult(id: ValidatorId, name: string, issues: ValidationIssue[], meta?: Record<string, unknown>): ValidatorResult {
  const errors = issues.filter(i => i.severity === 'error').length
  const warnings = issues.filter(i => i.severity === 'warning').length
  return { id, name, ok: errors === 0, errors, warnings, issues, meta }
}

function buildReport(episodeId: number, dramaId: number, results: ValidatorResult[]): ValidationReport {
  const errors = results.reduce((sum, r) => sum + r.errors, 0)
  const warnings = results.reduce((sum, r) => sum + r.warnings, 0)
  return {
    episodeId,
    dramaId,
    ok: errors === 0,
    errors,
    warnings,
    generatedAt: new Date().toISOString(),
    results,
  }
}

// ─── 数据库包装 ────────────────────────────────────────

async function loadEpisode(episodeId: number) {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error(`剧集不存在：${episodeId}`)
  return episode
}

async function loadProjectRows(dramaId: number) {
  const characters = (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId))).filter(c => !c.deletedAt)
  const scenes = (await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, dramaId))).filter(s => !s.deletedAt)
  const props = (await db.select().from(schema.props).where(eq(schema.props.dramaId, dramaId))).filter(p => !p.deletedAt)
  return { characters, scenes, props }
}

async function loadEpisodeLinks(episodeId: number) {
  const [characterLinks, sceneLinks, propLinks] = await Promise.all([
    db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)),
    db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)),
    db.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId)),
  ])
  return {
    characterIds: characterLinks.map(link => link.characterId),
    sceneIds: sceneLinks.map(link => link.sceneId),
    propIds: propLinks.map(link => link.propId),
  }
}

async function loadStoryboards(episodeId: number) {
  const rows = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))).filter(s => !s.deletedAt)
  const ids = rows.map(row => row.id)
  const characterLinks = ids.length
    ? await db.select().from(schema.storyboardCharacters).where(inArray(schema.storyboardCharacters.storyboardId, ids))
    : []
  const propLinks = ids.length
    ? await db.select().from(schema.storyboardProps).where(inArray(schema.storyboardProps.storyboardId, ids))
    : []
  const characterMap = new Map<number, number[]>()
  for (const link of characterLinks) {
    const list = characterMap.get(link.storyboardId) || []
    list.push(link.characterId)
    characterMap.set(link.storyboardId, list)
  }
  const propMap = new Map<number, number[]>()
  for (const link of propLinks) {
    const list = propMap.get(link.storyboardId) || []
    list.push(link.propId)
    propMap.set(link.storyboardId, list)
  }
  return rows.map(row => ({
    id: row.id,
    number: row.storyboardNumber,
    sceneId: row.sceneId,
    characterIds: characterMap.get(row.id) || [],
    propIds: propMap.get(row.id) || [],
    duration: row.duration || 0,
    description: row.description,
    shotType: row.shotType,
    angle: row.angle,
    movement: row.movement,
    videoPrompt: row.videoPrompt,
    imagePrompt: row.imagePrompt,
    composedImage: row.composedImage,
    firstFrameImage: row.firstFrameImage,
    lastFrameImage: row.lastFrameImage,
    videoUrl: row.videoUrl,
    composedVideoUrl: row.composedVideoUrl,
  }))
}

export async function validateScript(episodeId: number, dramaId?: number): Promise<ValidatorResult> {
  const episode = await loadEpisode(episodeId)
  return checkScript(episode.scriptContent || episode.content)
}

export async function validateAssets(episodeId: number, dramaId?: number): Promise<ValidatorResult> {
  const episode = await loadEpisode(episodeId)
  const resolvedDramaId = dramaId || episode.dramaId
  const [{ characters, scenes, props }, links] = await Promise.all([
    loadProjectRows(resolvedDramaId),
    loadEpisodeLinks(episodeId),
  ])
  const script = parseScript(episode.scriptContent || episode.content)
  return checkAssets({
    characters,
    scenes,
    props,
    episodeCharacterIds: links.characterIds,
    episodeSceneIds: links.sceneIds,
    episodePropIds: links.propIds,
    scriptSpeakers: script.dialogue.map(d => d.speaker),
    scriptPlaces: script.scenes.map(s => s.place),
  })
}

export async function validateStoryboards(episodeId: number, dramaId?: number): Promise<ValidatorResult> {
  const episode = await loadEpisode(episodeId)
  const [shots, links, script] = await Promise.all([
    loadStoryboards(episodeId),
    loadEpisodeLinks(episodeId),
    Promise.resolve(parseScript(episode.scriptContent || episode.content)),
  ])
  return checkStoryboards({
    shots,
    episodeSceneIds: links.sceneIds,
    episodeCharacterIds: links.characterIds,
    episodePropIds: links.propIds,
    scriptDialogueTexts: script.dialogue.map(d => d.text),
    targetDurationSeconds: (episode.scriptContent || episode.content || '').length / 500 * 60,
  })
}

export async function validateVideoPrompts(episodeId: number, dramaId?: number): Promise<ValidatorResult> {
  const episode = await loadEpisode(episodeId)
  const resolvedDramaId = dramaId || episode.dramaId
  const [{ characters, scenes, props }, shots, script, links] = await Promise.all([
    loadProjectRows(resolvedDramaId),
    loadStoryboards(episodeId),
    Promise.resolve(parseScript(episode.scriptContent || episode.content)),
    loadEpisodeLinks(episodeId),
  ])
  const episodeCharacters = characters.filter(c => links.characterIds.includes(c.id))
  const episodeScenes = scenes.filter(s => links.sceneIds.includes(s.id))
  const episodeProps = props.filter(p => links.propIds.includes(p.id))
  return checkVideoPrompts({
    shots,
    allowedRefs: [
      ...episodeCharacters.map(c => c.name),
      ...episodeScenes.map(s => s.location),
      ...episodeProps.map(p => p.name),
    ],
    scriptDialogueTexts: script.dialogue.map(d => d.text),
  })
}

export async function validateStyleLock(episodeId: number, dramaId?: number): Promise<ValidatorResult> {
  const episode = await loadEpisode(episodeId)
  const resolvedDramaId = dramaId || episode.dramaId
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, resolvedDramaId))
  const [{ characters, scenes, props }, stylePrompt, modeCtx, links] = await Promise.all([
    loadProjectRows(resolvedDramaId),
    getDramaStylePrompt(resolvedDramaId),
    resolveModeContext(resolvedDramaId, { stage: 'script', agentType: 'script_rewriter' }),
    loadEpisodeLinks(episodeId),
  ])
  const templatePrompts = Object.values(modeCtx.template?.agent_prompts || {}).map(value => String(value || ''))
  const episodeCharacters = characters.filter(c => links.characterIds.includes(c.id))
  const episodeScenes = scenes.filter(s => links.sceneIds.includes(s.id))
  const episodeProps = props.filter(p => links.propIds.includes(p.id))
  const imagePrompts = [
    ...episodeCharacters.map(c => c.finalPrompt),
    ...episodeScenes.map(s => s.finalPrompt),
    ...episodeProps.map(p => p.finalPrompt),
  ].filter((value): value is string => typeof value === 'string' && !!value.trim())

  return checkStyleLock({
    styleKey: String(drama?.style || ''),
    stylePrompt,
    templatePrompts,
    imagePrompts,
  })
}

function mediaExists(value?: string | null): boolean {
  if (!value) return false
  const raw = String(value).trim()
  if (!raw || /^https?:\/\//i.test(raw)) return false
  const abs = path.isAbsolute(raw)
    ? raw
    : raw.startsWith('static/')
      ? path.join(DATA_ROOT, raw)
      : path.join(STORAGE_ROOT, raw)
  try {
    const stat = fs.statSync(abs)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function taskTargetKey(task: any): string | null {
  if (task.type === 'video' && task.storyboardId) return `video:storyboard:${task.storyboardId}`
  if (task.type === 'image') {
    if (task.storyboardId) return `image:storyboard:${task.storyboardId}`
    if (task.characterId) return `image:character:${task.characterId}`
    if (task.sceneId) return `image:scene:${task.sceneId}`
    if (task.propId) return `image:prop:${task.propId}`
  }
  return null
}

export async function validateGenerationReceipts(episodeId: number, dramaId?: number): Promise<ValidatorResult> {
  const episode = await loadEpisode(episodeId)
  const resolvedDramaId = dramaId || episode.dramaId
  const [{ characters, scenes, props }, shots, links] = await Promise.all([
    loadProjectRows(resolvedDramaId),
    loadStoryboards(episodeId),
    loadEpisodeLinks(episodeId),
  ])
  const episodeCharacters = characters.filter(c => links.characterIds.includes(c.id))
  const episodeScenes = scenes.filter(s => links.sceneIds.includes(s.id))
  const episodeProps = props.filter(p => links.propIds.includes(p.id))
  const storyboardIds = shots.map(s => s.id)
  const targetIds = new Set([...storyboardIds, ...links.characterIds, ...links.sceneIds, ...links.propIds])

  const taskRows = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.dramaId, resolvedDramaId)))
    .filter(task => [task.storyboardId, task.characterId, task.sceneId, task.propId].some(id => id != null && targetIds.has(id)))

  const labels = new Map<string, string>()
  const expectations: GenerationExpectation[] = []
  const addExpectation = (key: string, label: string, hasOutput: boolean) => {
    labels.set(key, label)
    expectations.push({ key, label, hasOutput })
  }
  for (const character of episodeCharacters) {
    addExpectation(`image:character:${character.id}`, `角色图：${character.name}`, Boolean(character.imageUrl))
  }
  for (const scene of episodeScenes) {
    addExpectation(`image:scene:${scene.id}`, `场景图：${scene.location}`, Boolean(scene.imageUrl))
  }
  for (const prop of episodeProps) {
    addExpectation(`image:prop:${prop.id}`, `道具图：${prop.name}`, Boolean(prop.imageUrl))
  }
  for (const shot of shots) {
    addExpectation(
      `image:storyboard:${shot.id}`,
      `分镜图：S${shot.number}`,
      Boolean(shot.composedImage || shot.firstFrameImage || shot.lastFrameImage),
    )
    addExpectation(
      `video:storyboard:${shot.id}`,
      `镜头视频：S${shot.number}`,
      Boolean(shot.videoUrl || shot.composedVideoUrl),
    )
  }

  const tasks: GenerationReceiptTask[] = taskRows.map(task => {
    const key = taskTargetKey(task) || `task:${task.id}`
    return {
      id: task.id,
      type: task.type,
      status: String(task.status || ''),
      targetKey: key,
      targetLabel: labels.get(key) || `${task.type} #${task.id}`,
      localPath: task.localPath,
      resultUrl: task.resultUrl,
      localExists: task.localPath ? mediaExists(task.localPath) : undefined,
      errorMsg: task.errorMsg,
    }
  })

  return checkGenerationReceipts({ tasks, expectations })
}

export async function validateMergeReceipt(episodeId: number, dramaId?: number): Promise<ValidatorResult> {
  const episode = await loadEpisode(episodeId)
  const resolvedDramaId = dramaId || episode.dramaId
  const [shots, mergeRows] = await Promise.all([
    loadStoryboards(episodeId),
    db.select().from(schema.videoMerges)
      .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
      .orderBy(desc(schema.videoMerges.createdAt)),
  ])
  const merge = mergeRows[0]
  if (!merge) return checkMergeReceipt(null)

  let clips: string[] = []
  try {
    const parsed = merge.scenes ? JSON.parse(merge.scenes) : []
    if (Array.isArray(parsed)) clips = parsed.filter((item): item is string => typeof item === 'string' && !!item.trim())
  } catch {
    clips = []
  }

  return checkMergeReceipt({
    id: merge.id,
    status: String(merge.status || ''),
    mergedUrl: merge.mergedUrl,
    mergedExists: merge.mergedUrl ? mediaExists(merge.mergedUrl) : undefined,
    clips,
    clipsExist: clips.map(clip => mediaExists(clip)),
    duration: merge.duration,
    expectedDuration: shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    expectedClipCount: shots.length,
    errorMsg: merge.errorMsg,
  })
}

export async function validateEpisode(episodeId: number, dramaId?: number): Promise<ValidationReport> {
  const episode = await loadEpisode(episodeId)
  const resolvedDramaId = dramaId || episode.dramaId
  const results = await Promise.all([
    validateScript(episodeId, resolvedDramaId),
    validateAssets(episodeId, resolvedDramaId),
    validateStoryboards(episodeId, resolvedDramaId),
    validateVideoPrompts(episodeId, resolvedDramaId),
    validateStyleLock(episodeId, resolvedDramaId),
    validateGenerationReceipts(episodeId, resolvedDramaId),
    validateMergeReceipt(episodeId, resolvedDramaId),
  ])
  return buildReport(episodeId, resolvedDramaId, results)
}

export async function validateStage(stage: string, episodeId: number, dramaId?: number): Promise<ValidatorResult> {
  switch (stage) {
    case 'script':
    case 'V1':
      return validateScript(episodeId, dramaId)
    case 'extract':
    case 'V2':
      return validateAssets(episodeId, dramaId)
    case 'storyboard':
    case 'V3':
      return validateStoryboards(episodeId, dramaId)
    case 'video_prompt':
    case 'V4':
      return validateVideoPrompts(episodeId, dramaId)
    case 'style':
    case 'V5':
      return validateStyleLock(episodeId, dramaId)
    case 'generation':
    case 'video':
    case 'V6':
      return validateGenerationReceipts(episodeId, dramaId)
    case 'merge':
    case 'V7':
      return validateMergeReceipt(episodeId, dramaId)
    default:
      throw new Error(`未知校验阶段：${stage}`)
  }
}
