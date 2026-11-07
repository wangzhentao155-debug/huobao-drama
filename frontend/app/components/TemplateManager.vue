<template>
  <div class="tpl-page">
    <div class="tpl-head">
      <div>
        <h2 class="tpl-title">系统配置</h2>
        <p class="tpl-desc">阶段与 Agent 固定；按模式配置 System Prompt、Skills 开关与阶段参数。</p>
      </div>
      <button class="btn" :disabled="loading" @click="load">刷新</button>
    </div>

    <div class="tpl-warning">
      规范/参数修改只对<strong>新建项目</strong>或<strong>重新选择该模式</strong>的项目生效；Skills 开关与 Skills 内容修改立即生效。
    </div>

    <div :class="['tpl-lock-bar', { unlocked: !locked }]">
      <span>{{ locked ? '模板编辑已锁定（只读）' : '编辑已解锁（本次会话有效）' }}</span>
      <button class="btn" @click="toggleLock">{{ locked ? '解锁编辑' : '重新锁定' }}</button>
    </div>

    <section v-if="draft" class="tpl-work">
      <div class="tpl-mode-row">
        <label class="tpl-field">
          <span class="tpl-label">制作模式</span>
          <select v-model="selectedId" class="tpl-select-wide" @change="onModeSelect">
            <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}（v{{ tpl.version }} · {{ stageCount(tpl) }} 阶段）</option>
          </select>
        </label>
      </div>

      <div class="tpl-main">
        <nav class="tpl-stages">
          <button
            v-for="row in stageRows"
            :key="row.stageId"
            :class="['tpl-stage', { active: row.stageId === selectedStageId, service: !row.configKey }]"
            @click="selectStage(row)"
          >
            <span class="tpl-stage-name">{{ row.stageLabel }}</span>
            <span class="tpl-stage-agent">{{ row.agentLabel }}</span>
          </button>
        </nav>

        <div class="tpl-card">
          <div class="tpl-card-head">
            <div>
              <h3>{{ draft.name }}</h3>
              <p class="tpl-sub">id：{{ draft.id }} · 版本 {{ draft.version }}</p>
            </div>
            <span v-if="selectedRow" class="tpl-card-context">{{ selectedRow.stageLabel }} · {{ selectedRow.agentLabel }}</span>
          </div>

          <div v-if="selectedRow && selectedRow.configKey" class="tpl-card-body">

            <div class="tpl-tabs">
              <button :class="['tpl-tab', { active: tab === 'prompt' }]" @click="tab = 'prompt'">System Prompt</button>
              <button :class="['tpl-tab', { active: tab === 'skills' }]" @click="openSkills">Skills ({{ skillCount }})</button>
              <button :class="['tpl-tab', { active: tab === 'runtime' }]" @click="tab = 'runtime'">阶段参数</button>
              <button :class="['tpl-tab', { active: tab === 'preview' }]" @click="openPreview">装配预览</button>
            </div>

            <div v-if="tab === 'prompt'" class="tpl-pane">
              <p class="tpl-hint">
                这里只写该模式的差异部分，会追加在全局基础提示词之后。留空 = 只用全局基础规范
                <span v-if="selectedRow.configKey === 'image' || selectedRow.configKey === 'video_prompt'">（也可留空，回退到「提示词生成」的规范）</span>。
              </p>
              <textarea v-model="draft.agent_prompts[selectedRow.configKey]" class="tpl-textarea tpl-prompt" rows="14" :disabled="locked" />
            </div>

            <div v-else-if="tab === 'skills'" class="tpl-pane">
              <div class="tpl-skill-head">
                <p class="tpl-hint">Skills 成套加载，可整套开启/关闭；点开一条可直接编辑内容。全局基础 Skills 不受影响。</p>
                <button class="btn" :disabled="locked" @click="startAddSkill">+ 新增 Skill</button>
              </div>
              <div v-if="showAddSkill && !locked" class="tpl-add-skill">
                <input v-model="newSkill.id" class="tpl-input-wide" placeholder="Skill id（小写字母/数字/连字符，如 hook-rules）" />
                <input v-model="newSkill.name" class="tpl-input-wide" placeholder="显示名称（可选）" />
                <input v-model="newSkill.description" class="tpl-input-wide" placeholder="描述（可选）" />
                <div class="tpl-actions right">
                  <button class="btn" @click="showAddSkill = false">取消</button>
                  <button class="btn btn-primary" @click="createSkill">创建</button>
                </div>
              </div>
              <div class="tpl-skill-list">
                <div
                  v-for="ref in skillRefs"
                  :key="ref.id"
                  :class="['tpl-skill-card', { open: editingSkillId === ref.id }]"
                >
                  <div class="tpl-skill-row" @click="toggleSkill(ref.id)">
                    <input v-model="ref.enabled" type="checkbox" :disabled="locked" @click.stop />
                    <span class="tpl-skill-name">{{ skillName(ref.id) }}</span>
                    <small class="tpl-skill-id">{{ ref.id }}</small>
                    <button
                      v-if="ref.id !== baseSkillId"
                      type="button"
                      class="btn btn-mini btn-danger"
                      :disabled="locked"
                      @click.stop="deleteSkillSet(ref)"
                    >删除</button>
                    <span class="tpl-skill-chevron">{{ editingSkillId === ref.id ? '▴' : '▾' }}</span>
                  </div>
                  <div v-if="editingSkillId === ref.id" class="tpl-skill-editor">
                    <textarea v-model="skillContent" class="tpl-textarea" rows="16" :disabled="locked" />
                    <div class="tpl-actions right">
                      <button class="btn btn-primary" :disabled="skillSaving || locked" @click="saveSkill">{{ skillSaving ? '保存中…' : '保存 Skill' }}</button>
                    </div>
                  </div>
                </div>
                <p v-if="!skillRefs.length" class="tpl-hint">该 Agent 在该模式下没有模板 Skills。</p>
              </div>
            </div>

            <div v-else-if="tab === 'runtime'" class="tpl-pane">
              <p class="tpl-hint">温度 0–2；步数 1–50；越界保存会被拒绝。</p>
              <div class="tpl-runtime-row">
                <span class="tpl-label">{{ selectedRow.stageLabel }}</span>
                <label class="tpl-inline">
                  温度
                  <input v-model.number="runtimeOf(selectedRow.stageId).temperature" class="tpl-input" type="number" min="0" max="2" step="0.05" :disabled="locked" />
                </label>
                <label class="tpl-inline">
                  步数
                  <input v-model.number="runtimeOf(selectedRow.stageId).maxSteps" class="tpl-input" type="number" min="1" max="50" step="1" :disabled="locked" />
                </label>
              </div>
            </div>

            <div v-else class="tpl-pane">
              <div class="tpl-preview-controls">
                <span class="tpl-preview-fixed">{{ selectedRow.agentLabel }} · {{ selectedRow.stageLabel }}</span>
                <button class="btn" @click="runPreview">生成预览</button>
              </div>
              <p v-if="previewSize" class="tpl-hint">
                基础 {{ previewSize.base }} 字 · 模板 {{ previewSize.template }} 字 · Skills {{ previewSize.skills }} 字 ·
                合计 {{ previewSize.total }} 字（约 {{ Math.ceil(previewSize.total / 1.8) }} tokens）
              </p>
              <pre class="tpl-preview">{{ previewText || '点击「生成预览」查看最终系统提示词' }}</pre>
            </div>
          </div>

          <div v-else class="tpl-empty">该模式没有可配置的 Agent 阶段。</div>

          <div class="tpl-card-foot">
            <button class="btn" :disabled="saving || locked" @click="restore">恢复默认</button>
            <button class="btn btn-primary" :disabled="saving || locked" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { toast } from 'vue-sonner'
import { templateAPI, skillsAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const STAGE_CONFIG = {
  script: { key: 'script_rewriter', agent: 'script_rewriter', label: '剧本改写' },
  extract: { key: 'extractor', agent: 'extractor', label: '角色场景提取' },
  storyboard: { key: 'storyboard_breaker', agent: 'storyboard_breaker', label: '分镜拆解' },
  video_prompt: { key: 'video_prompt', agent: 'prompt_generator', label: '提示词生成' },
  image: { key: 'image', agent: 'prompt_generator', label: '提示词生成' },
}

const templates = ref([])
const selectedId = ref('')
const draft = ref(null)
const selectedStageId = ref('')
const tab = ref('prompt')
const loading = ref(false)
const saving = ref(false)
const locked = ref(true)

const allSkills = ref([])
const skillRefs = ref([])
const skillCount = computed(() => {
  const key = selectedRow.value?.configKey
  if (!draft.value || !key) return 0
  return (draft.value.agent_skills?.[key] || []).length
})
const editingSkillId = ref('')
const skillContent = ref('')
const skillSaving = ref(false)
const showAddSkill = ref(false)
const newSkill = ref({ id: '', name: '', description: '' })

const SKILL_DIR = {
  script_rewriter: 'script-rewriter',
  extractor: 'extractor',
  storyboard_breaker: 'storyboard-breaker',
  prompt_generator: 'prompt-generator',
  image: 'prompt-generator',
  video_prompt: 'prompt-generator',
}

const previewText = ref('')
const previewSize = ref(null)

const stageRows = computed(() => {
  const stages = draft.value?.workflow?.stages || []
  return stages
    .filter(stage => STAGE_CONFIG[stage.id])
    .map(stage => {
      const cfg = STAGE_CONFIG[stage.id]
      return {
        stageId: stage.id,
        stageLabel: stage.label,
        agentLabel: cfg.label,
        agent: cfg.agent,
        configKey: cfg.key,
      }
    })
})

const selectedRow = computed(() => {
  const rows = stageRows.value
  return rows.find(r => r.stageId === selectedStageId.value)
    || rows.find(r => r.configKey)
    || null
})

const baseSkillId = computed(() => {
  if (!draft.value || !selectedRow.value?.configKey) return ''
  const dir = SKILL_DIR[selectedRow.value.configKey] || selectedRow.value.configKey
  return `templates/${draft.value.id}/${dir}`
})

function stageCount(tpl) {
  return tpl?.workflow?.stages?.length || 0
}

function normalizeRefs(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => {
      if (typeof item === 'string' && item.trim()) return { id: item.trim(), enabled: true }
      if (item && typeof item === 'object' && typeof item.id === 'string' && item.id.trim()) {
        return { id: item.id.trim(), enabled: item.enabled !== false }
      }
      return null
    })
    .filter(Boolean)
}

function ensureDraft(tpl) {
  const d = JSON.parse(JSON.stringify(tpl))
  d.agent_prompts = d.agent_prompts || {}
  for (const key of ['script_rewriter', 'extractor', 'storyboard_breaker', 'prompt_generator', 'image', 'video_prompt']) {
    if (typeof d.agent_prompts[key] !== 'string') d.agent_prompts[key] = ''
  }
  d.stage_runtime = d.stage_runtime || {}
  for (const id of ['script', 'extract', 'storyboard', 'video_prompt', 'image']) {
    d.stage_runtime[id] = d.stage_runtime[id] || {}
  }
  const skills = {}
  for (const key of ['script_rewriter', 'extractor', 'storyboard_breaker', 'prompt_generator', 'image', 'video_prompt']) {
    skills[key] = normalizeRefs(d.agent_skills?.[key])
  }
  d.agent_skills = skills
  return d
}

function runtimeOf(stageId) {
  if (!draft.value.stage_runtime[stageId]) draft.value.stage_runtime[stageId] = {}
  return draft.value.stage_runtime[stageId]
}

async function loadAllSkills() {
  if (allSkills.value.length) return
  try { allSkills.value = await skillsAPI.list('zh') || [] } catch { allSkills.value = [] }
}

function skillName(id) {
  const meta = allSkills.value.find(s => s.id === id)
  return meta?.description || meta?.name || id
}

async function refreshSkillRefs() {
  if (!draft.value || !selectedRow.value?.configKey) { skillRefs.value = []; return }
  const key = selectedRow.value.configKey
  if (!Array.isArray(draft.value.agent_skills[key])) draft.value.agent_skills[key] = []
  skillRefs.value = draft.value.agent_skills[key]
  editingSkillId.value = ''
  skillContent.value = ''
  previewText.value = ''
  previewSize.value = null
  await loadAllSkills()
}

function select(tpl) {
  selectedId.value = tpl.id
  draft.value = ensureDraft(tpl)
  tab.value = 'prompt'
  const firstConfigurable = (tpl.workflow?.stages || []).find(s => STAGE_CONFIG[s.id])
  selectedStageId.value = firstConfigurable?.id || ''
  refreshSkillRefs()
}

function onModeSelect() {
  const tpl = templates.value.find(t => t.id === selectedId.value)
  if (tpl) select(tpl)
}

function onStageChange() {
  const row = stageRows.value.find(r => r.stageId === selectedStageId.value)
  if (row) selectStage(row)
}

function selectStage(row) {
  selectedStageId.value = row.stageId
  tab.value = 'prompt'
  previewText.value = ''
  previewSize.value = null
  refreshSkillRefs()
}

async function openSkills() {
  tab.value = 'skills'
  await refreshSkillRefs()
}

function openPreview() {
  tab.value = 'preview'
  previewText.value = ''
  previewSize.value = null
}

async function editSkill(id) {
  try {
    const res = await skillsAPI.get(id, 'zh')
    editingSkillId.value = id
    skillContent.value = res?.content || ''
  } catch (e) {
    toastError(e)
  }
}

async function toggleSkill(id) {
  if (editingSkillId.value === id) {
    editingSkillId.value = ''
    skillContent.value = ''
    return
  }
  await editSkill(id)
}

function toggleLock() {
  if (locked.value) {
    if (!window.confirm('解锁后可以修改该模式的 System Prompt、Skills 与阶段参数。确定解锁？')) return
    locked.value = false
  } else {
    locked.value = true
    showAddSkill.value = false
  }
}

function startAddSkill() {
  newSkill.value = { id: '', name: '', description: '' }
  showAddSkill.value = true
}

async function createSkill() {
  if (!draft.value || !selectedRow.value?.configKey) return
  const setId = newSkill.value.id.trim().toLowerCase()
  if (!/^[a-z0-9-]+$/.test(setId)) {
    toast.error('Skill id 只能包含小写字母、数字和连字符')
    return
  }
  const dir = SKILL_DIR[selectedRow.value.configKey] || selectedRow.value.configKey
  const id = `templates/${draft.value.id}/${dir}-${setId}`
  const refs = draft.value.agent_skills[selectedRow.value.configKey]
  if (refs.some(ref => ref.id === id)) {
    toast.error('该 Skill 已存在')
    return
  }
  try {
    await skillsAPI.create({
      id,
      name: newSkill.value.name || setId,
      description: newSkill.value.description || newSkill.value.name || setId,
    })
    refs.push({ id, enabled: true })
    showAddSkill.value = false
    allSkills.value = []
    await loadAllSkills()
    await editSkill(id)
    toast.success('Skill 已创建，记得点右上角「保存」写入模板')
  } catch (e) {
    toastError(e)
  }
}

async function deleteSkillSet(ref) {
  if (!draft.value || !selectedRow.value?.configKey) return
  if (!window.confirm('删除这套 Skills？目录和内容会一起删除（已自动备份）。')) return
  try {
    await skillsAPI.del(ref.id)
    const refs = draft.value.agent_skills[selectedRow.value.configKey]
    draft.value.agent_skills[selectedRow.value.configKey] = refs.filter(item => item.id !== ref.id)
    skillRefs.value = draft.value.agent_skills[selectedRow.value.configKey]
    if (editingSkillId.value === ref.id) {
      editingSkillId.value = ''
      skillContent.value = ''
    }
    allSkills.value = []
    await loadAllSkills()
    toast.success('Skill 已删除，记得点右上角「保存」写入模板')
  } catch (e) {
    toastError(e)
  }
}

async function saveSkill() {
  if (!editingSkillId.value) return
  skillSaving.value = true
  try {
    await skillsAPI.update(editingSkillId.value, skillContent.value, 'zh')
    allSkills.value = []
    await loadAllSkills()
    toast.success('Skill 已保存（立即生效）')
  } catch (e) {
    toastError(e)
  } finally {
    skillSaving.value = false
  }
}

async function load() {
  loading.value = true
  try {
    templates.value = await templateAPI.list() || []
    const target = templates.value.find(t => t.id === selectedId.value) || templates.value[0]
    if (target) select(target)
  } catch (e) {
    toastError(e)
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!draft.value) return
  saving.value = true
  try {
    const updated = await templateAPI.update(draft.value.id, {
      agent_prompts: draft.value.agent_prompts,
      agent_skills: draft.value.agent_skills,
      stage_runtime: draft.value.stage_runtime,
    })
    const idx = templates.value.findIndex(t => t.id === updated.id)
    if (idx >= 0) templates.value[idx] = updated
    const keepStage = selectedStageId.value
    draft.value = ensureDraft(updated)
    selectedStageId.value = keepStage
    previewText.value = ''
    previewSize.value = null
    await refreshSkillRefs()
    toast.success(`模板已保存（版本 ${updated.version}）`)
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

async function restore() {
  if (!draft.value) return
  if (!window.confirm('恢复为首次保存前的默认内容？当前内容会自动备份。')) return
  saving.value = true
  try {
    const restored = await templateAPI.restore(draft.value.id)
    const idx = templates.value.findIndex(t => t.id === restored.id)
    if (idx >= 0) templates.value[idx] = restored
    const keepStage = selectedStageId.value
    draft.value = ensureDraft(restored)
    selectedStageId.value = keepStage
    previewText.value = ''
    previewSize.value = null
    await refreshSkillRefs()
    toast.success(`已恢复默认（版本 ${restored.version}）`)
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

async function runPreview() {
  const row = selectedRow.value
  if (!draft.value || !row?.agent) return
  try {
    const res = await templateAPI.preview(draft.value.id, row.agent, row.stageId)
    previewText.value = res?.system_prompt || ''
    previewSize.value = res?.sizes || null
  } catch (e) {
    toastError(e)
  }
}

onMounted(load)
</script>

<style scoped>
.tpl-page { padding: 24px; max-width: 100%; box-sizing: border-box; }
.tpl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; flex-wrap: wrap; }
.tpl-title { margin: 0 0 4px; font-size: 20px; font-weight: 700; color: var(--text-0, #111); }
.tpl-desc { margin: 0; font-size: 13px; color: var(--text-2, #666); }
.tpl-warning { margin-bottom: 16px; padding: 10px 12px; border-radius: 8px; background: rgba(255, 170, 0, .1); border: 1px solid rgba(255, 170, 0, .3); font-size: 12px; color: var(--text-1, #444); }
.tpl-lock-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: 8px; background: rgba(0,0,0,.05); border: 1px solid var(--border, rgba(0,0,0,.1)); margin-bottom: 12px; font-size: 12px; color: var(--text-1, #444); }
.tpl-lock-bar.unlocked { background: rgba(255, 170, 0, .12); border-color: rgba(255, 170, 0, .35); }
.tpl-textarea:disabled, .tpl-input:disabled { opacity: .7; cursor: not-allowed; }
.tpl-mode-row { margin-bottom: 12px; max-width: 340px; }
.tpl-field { display: flex; flex-direction: column; gap: 4px; }
.tpl-select-wide { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, rgba(0,0,0,.12)); background: var(--bg-1, #fff); color: var(--text-0, #111); font-size: 13px; min-width: 240px; }
.tpl-work { min-width: 0; }
.tpl-main { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; align-items: start; }
.tpl-stages { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tpl-stage { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, rgba(0,0,0,.08)); background: transparent; text-align: left; cursor: pointer; }
.tpl-stage:hover { background: var(--bg-hover, rgba(0,0,0,.04)); }
.tpl-stage.active { border-color: var(--accent, #ff7a45); background: var(--accent-bg, rgba(255,122,69,.08)); }
.tpl-stage-name { font-size: 11px; color: var(--text-2, #888); }
.tpl-stage-agent { font-size: 12px; font-weight: 600; color: var(--text-0, #111); }
.tpl-card { min-width: 0; border: 1px solid var(--border, rgba(0,0,0,.1)); border-radius: 12px; background: var(--bg-1, #fff); overflow: hidden; }
.tpl-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--border, rgba(0,0,0,.08)); flex-wrap: wrap; }
.tpl-card-head h3 { margin: 0 0 2px; font-size: 16px; }
.tpl-card-context { font-size: 12px; color: var(--text-2, #888); }
.tpl-card-body { padding: 16px; }
.tpl-card-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border, rgba(0,0,0,.08)); background: var(--bg-2, #f7f7f7); }
.tpl-prompt { min-height: 360px; }
.tpl-empty { padding: 24px; color: var(--text-2, #888); font-size: 12px; }
.tpl-sub { margin: 0; font-size: 12px; color: var(--text-2, #888); word-break: break-all; }
.tpl-actions { display: flex; gap: 8px; }
.tpl-actions.right { justify-content: flex-end; }
.tpl-grid { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 16px; align-items: start; }
.tpl-detail { min-width: 0; }
.tpl-detail-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.tpl-detail-head h4 { margin: 0; font-size: 14px; }
.tpl-empty { padding: 24px; border: 1px dashed var(--border, rgba(0,0,0,.15)); border-radius: 8px; color: var(--text-2, #888); font-size: 12px; }
.tpl-tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.tpl-tab { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border, rgba(0,0,0,.1)); background: transparent; font-size: 12px; cursor: pointer; color: var(--text-1, #444); }
.tpl-tab.active { background: var(--accent-bg, rgba(255,122,69,.1)); border-color: var(--accent, #ff7a45); color: var(--accent-text, #d35400); font-weight: 600; }
.tpl-pane { display: flex; flex-direction: column; gap: 10px; }
.tpl-hint { margin: 0; font-size: 12px; color: var(--text-2, #888); }
.tpl-textarea { width: 100%; min-height: 120px; padding: 10px; border-radius: 8px; border: 1px solid var(--border, rgba(0,0,0,.12)); background: var(--bg-1, #fff); color: var(--text-0, #111); font-size: 12px; line-height: 1.6; resize: vertical; box-sizing: border-box; }
.tpl-prompt { min-height: 280px; }
.tpl-skill-list { display: flex; flex-direction: column; gap: 8px; }
.tpl-skill-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.tpl-skill-card { border: 1px solid var(--border, rgba(0,0,0,.1)); border-radius: 10px; background: var(--bg-1, #fff); overflow: hidden; }
.tpl-skill-card.open { border-color: var(--accent, #ff7a45); }
.tpl-skill-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; font-size: 12px; }
.tpl-skill-name { flex: 1; color: var(--text-0, #111); font-weight: 600; }
.tpl-skill-id { color: var(--text-2, #888); font-size: 10px; word-break: break-all; }
.tpl-skill-chevron { color: var(--text-2, #888); font-size: 11px; }
.tpl-skill-editor { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-top: 1px solid var(--border, rgba(0,0,0,.08)); background: var(--bg-2, #f7f7f7); }
.tpl-add-skill { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px dashed var(--border, rgba(0,0,0,.2)); border-radius: 8px; margin-bottom: 10px; }
.tpl-input-wide { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, rgba(0,0,0,.12)); background: var(--bg-1, #fff); color: var(--text-0, #111); font-size: 12px; }
.tpl-skill-editor .tpl-textarea { background: var(--bg-1, #fff); }
.tpl-skill-editor .tpl-actions { margin-top: 2px; }
.btn-mini { padding: 4px 8px; font-size: 11px; }
.btn-danger { color: #b91c1c; border-color: rgba(185,28,28,.35); }
.tpl-runtime-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.tpl-label { font-size: 12px; font-weight: 600; min-width: 80px; }
.tpl-inline { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-1, #444); }
.tpl-input { width: 80px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border, rgba(0,0,0,.12)); background: var(--bg-1, #fff); color: var(--text-0, #111); font-size: 12px; }
.tpl-preview-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tpl-preview-fixed { font-size: 12px; font-weight: 600; }
.tpl-preview { margin: 0; padding: 12px; border-radius: 8px; background: var(--bg-2, #f6f6f6); border: 1px solid var(--border, rgba(0,0,0,.08)); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 520px; overflow: auto; }

@media (max-width: 1100px) {
  .tpl-main { grid-template-columns: minmax(0, 1fr); }
  .tpl-stages { flex-direction: row; overflow-x: auto; padding-bottom: 4px; }
  .tpl-stage { min-width: 140px; }
  .tpl-mode-row { max-width: none; }
}
@media (max-width: 700px) {
  .tpl-page { padding: 12px; }
  .tpl-tabs { flex-wrap: wrap; }
  .tpl-select-wide { width: 100%; min-width: 0; box-sizing: border-box; }
}
</style>
