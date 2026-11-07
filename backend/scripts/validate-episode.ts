/**
 * 命令行运行 V1–V5 校验：
 *   cd backend && npx tsx scripts/validate-episode.ts <episodeId> [stage]
 *
 * stage 可选：script / extract / storyboard / video_prompt / style（或 V1–V5）
 * 有错误时退出码为 1，便于 CI/验收脚本使用。
 */
import { validateEpisode, validateStage } from '../src/services/validators.js'

const episodeId = Number(process.argv[2])
if (!Number.isInteger(episodeId) || episodeId <= 0) {
  console.error('用法：npx tsx scripts/validate-episode.ts <episodeId> [stage]')
  process.exit(2)
}

const stage = process.argv[3]
try {
  const result = stage
    ? await validateStage(stage, episodeId)
    : await validateEpisode(episodeId)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = 'ok' in result && result.ok === false ? 1 : 0
} catch (error: any) {
  console.error(error?.message || '校验失败')
  process.exitCode = 2
}
