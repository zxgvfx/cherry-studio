import type { PipelineRunStepProgress } from '@shared/data/types/uiParts'

export const ACTIVE_STATES = new Set(['running', 'retrying', 'awaiting_human', 'awaiting_approval'])
export const DONE_STATES = new Set(['success', 'cached', 'skipped'])

const NODE_LABELS: Record<string, string> = {
  'human.approve': '人工审核',
  'human.review': '人工审阅',
  'data.load-image': '加载图片',
  'data.load-video': '加载视频',
  'data.load-file': '加载文件',
  'data.set': '设置数据',
  'model.async-call': '模型调用',
  'model.text-to-image': '文生图',
  'model.image-to-image': '图生图',
  'model.tripo3d': 'Tripo 3D',
  'imgproc.split-three-view': '裁切三视图',
  'io.workflow-input': '输入',
  'io.workflow-output': '输出',
  pixal3d: '图生3D',
  'pixal3d-image-to-3d': '图生3D'
}

const TOKEN_ZH: Record<string, string> = {
  style: '风格',
  in: '输入',
  input: '输入',
  out: '输出',
  output: '输出',
  gen3d: '生成3D',
  gen: '生成',
  generate: '生成',
  load: '加载',
  export: '导出',
  import: '导入',
  tex: '贴图',
  seg: '分割',
  split: '裁切'
}

const NODE_PURPOSE: Record<string, string> = {
  风格: '设定画面风格',
  输入: '接入所需素材',
  生成3D: '根据参考图生成三维模型',
  输出: '导出三维结果',
  加载图片: '载入图片素材',
  加载视频: '载入视频素材',
  加载文件: '载入文件素材',
  图生3D: '把图片转成三维模型',
  文生图: '按提示词生成参考图',
  图生图: '按参考图改图',
  导出: '导出生成结果',
  设置数据: '写入节点参数',
  模型调用: '调用生成模型',
  人工审核: '等待人工确认后再继续',
  人工审阅: '等待人工审阅后再继续',
  生成: '执行生成步骤',
  一致性三视图: '一次生成正交三联图',
  'Tripo 生3D': '多视图重建三维几何',
  'Tripo 贴图': '给模型生成贴图',
  'Tripo 分割': '按部件拆分网格',
  'Tripo 3D': '调用 Tripo 生成三维结果',
  裁切三视图: '从三联图裁出正侧背'
}

export type PipelineRunStepGroup = {
  key: string
  steps: PipelineRunStepProgress[]
  state: string
  progress: number
  label: string
  purpose: string
}

function lastToken(id: string): string {
  return (id.split(/[/.]/).filter(Boolean).pop() || id).toLowerCase()
}

function isIoWrapper(nodeId: string): boolean {
  return nodeId === 'io.workflow-input' || nodeId === 'io.workflow-output'
}

export function canvasStepGroupKey(step: Pick<PipelineRunStepProgress, 'stepId' | 'nodeId'>): string {
  const id = (step.stepId || step.nodeId || '').trim()
  const slash = id.indexOf('/')
  return slash === -1 ? id || step.nodeId : id.slice(0, slash)
}

export function nodeTypeLabel(nodeId: string): string {
  if (!nodeId) return ''
  if (NODE_LABELS[nodeId]) return NODE_LABELS[nodeId]
  if (nodeId.startsWith('pixal3d')) return '图生3D'
  if (nodeId.startsWith('blender') && nodeId.includes('export')) return '导出'
  if (nodeId.startsWith('blender')) return 'Blender'
  const tokenZh = TOKEN_ZH[lastToken(nodeId)]
  if (tokenZh) return tokenZh
  const tail = nodeId.split('.').pop() || nodeId
  return tail.replace(/-/g, ' ')
}

export function stepTitle(step: PipelineRunStepProgress, index: number): string {
  return step.stepId || nodeTypeLabel(step.nodeId) || `节点${index + 1}`
}

export function displayStepLabel(step: PipelineRunStepProgress, index: number): string {
  const fromNode = nodeTypeLabel(step.nodeId)
  if (fromNode && /[\u4e00-\u9fff]/.test(fromNode)) return fromNode
  const fromStep = TOKEN_ZH[lastToken(step.stepId || '')]
  if (fromStep) return fromStep
  return fromNode || stepTitle(step, index)
}

export function stepPurpose(step: PipelineRunStepProgress, index: number): string {
  const label = displayStepLabel(step, index)
  if (NODE_PURPOSE[label]) return NODE_PURPOSE[label]
  if (step.nodeId && NODE_PURPOSE[nodeTypeLabel(step.nodeId)]) return NODE_PURPOSE[nodeTypeLabel(step.nodeId)]
  const message = step.message?.trim()
  if (message && message !== label) return message
  return `${label}步骤`
}

export function canvasGroupLabel(group: Pick<PipelineRunStepGroup, 'key' | 'steps'>): string {
  const work = group.steps.filter((step) => !isIoWrapper(step.nodeId))
  const pool = work.length > 0 ? work : group.steps
  const nodeIds = pool.map((step) => step.nodeId)
  const tokens = new Set(
    [group.key, ...pool.map((step) => step.stepId), ...nodeIds]
      .join('/')
      .toLowerCase()
      .split(/[/_.-]+/)
      .filter(Boolean)
  )
  if (nodeIds.some((id) => id.includes('image-to-image')) && nodeIds.some((id) => id.includes('split-three-view'))) {
    return '一致性三视图'
  }
  if (tokens.has('seg') || tokens.has('segment')) return 'Tripo 分割'
  if (tokens.has('tex') || tokens.has('texture')) return 'Tripo 贴图'
  if ((tokens.has('gen3d') || tokens.has('multiview')) && nodeIds.some((id) => id.includes('tripo3d'))) {
    return 'Tripo 生3D'
  }
  return displayStepLabel(pool[0] || group.steps[0], 0)
}

function groupInnerProgress(steps: PipelineRunStepProgress[]): number {
  if (steps.length === 0) return 0
  const done = steps.filter((step) => DONE_STATES.has(step.state)).length
  const active = steps.find((step) => ACTIVE_STATES.has(step.state))
  const extra = active && typeof active.progress === 'number' ? Math.min(1, Math.max(0, active.progress)) : 0
  return Math.min(1, (done + extra) / steps.length)
}

function aggregateGroupState(steps: PipelineRunStepProgress[]): { state: string; progress: number } {
  if (steps.some((step) => step.state === 'failed')) return { state: 'failed', progress: groupInnerProgress(steps) }
  if (steps.some((step) => step.state === 'cancelled'))
    return { state: 'cancelled', progress: groupInnerProgress(steps) }
  if (steps.some((step) => ACTIVE_STATES.has(step.state))) {
    return { state: 'running', progress: groupInnerProgress(steps) }
  }
  if (steps.every((step) => DONE_STATES.has(step.state))) return { state: 'success', progress: 1 }
  return { state: 'pending', progress: 0 }
}

export function groupPipelineRunSteps(steps: PipelineRunStepProgress[]): PipelineRunStepGroup[] {
  const order: string[] = []
  const byKey = new Map<string, PipelineRunStepProgress[]>()
  for (const step of steps) {
    const key = canvasStepGroupKey(step)
    if (!byKey.has(key)) {
      byKey.set(key, [])
      order.push(key)
    }
    byKey.get(key)!.push(step)
  }
  return order.map((key) => {
    const grouped = byKey.get(key) || []
    const { state, progress } = aggregateGroupState(grouped)
    const draft = { key, steps: grouped, state, progress, label: '', purpose: '' }
    const label = canvasGroupLabel(draft)
    return {
      ...draft,
      label,
      purpose: NODE_PURPOSE[label] || `${label}步骤`
    }
  })
}

export function overallGroupProgress(groups: PipelineRunStepGroup[]): number | null {
  if (groups.length === 0) return null
  const units = groups.reduce((sum, group) => {
    if (DONE_STATES.has(group.state)) return sum + 1
    if (ACTIVE_STATES.has(group.state) || group.state === 'awaiting_human' || group.state === 'awaiting_approval') {
      return sum + Math.min(1, Math.max(0, group.progress))
    }
    return sum
  }, 0)
  return units / groups.length
}
