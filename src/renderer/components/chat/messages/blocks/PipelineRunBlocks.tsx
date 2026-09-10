import type {
  PipelineReviewPartData,
  PipelineRunProgressPartData,
  PipelineRunStepProgress
} from '@shared/data/types/uiParts'
import React from 'react'

import {
  ACTIVE_STATES,
  displayStepLabel,
  DONE_STATES,
  groupPipelineRunSteps,
  overallGroupProgress,
  type PipelineRunStepGroup
} from './pipelineRunProgress'
import { isReviewDismissed, markReviewDismissed } from './reviewDismissal'

function statusLabel(status: string, phase?: 'canvas' | 'run'): string {
  if (phase === 'canvas') {
    if (status === 'success') return '已完成'
    if (status === 'failed') return '失败'
    return '进行中'
  }
  switch (status) {
    case 'pending':
      return '排队中'
    case 'running':
      return '运行中'
    case 'awaiting_human':
    case 'awaiting_approval':
      return '等待审核'
    case 'success':
    case 'verified':
    case 'delivered':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return status || '进行中'
  }
}

function formatElapsed(seconds?: number): string {
  if (!seconds || seconds < 0) return ''
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins <= 0) return `${secs}s`
  if (mins < 60) return `${mins}m ${secs}s`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}m`
}

function overallProgress(steps: PipelineRunStepProgress[]): number | null {
  return overallGroupProgress(groupPipelineRunSteps(steps))
}

function queueLinesOf(data: PipelineRunProgressPartData): string[] {
  if (data.queueLines?.length) return data.queueLines.filter((line) => line.trim())
  if (data.queue?.trim())
    return data.queue
      .split(/[;；]/)
      .map((line) => line.trim())
      .filter(Boolean)
  return []
}

function currentStep(
  data: PipelineRunProgressPartData,
  steps: PipelineRunStepProgress[]
): PipelineRunStepProgress | null {
  if (data.stepId) {
    const matched = steps.find((step) => step.stepId === data.stepId)
    if (matched) return matched
  }
  return steps.find((step) => ACTIVE_STATES.has(step.state)) ?? null
}

function asFiniteInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function aheadCountOf(data: PipelineRunProgressPartData, active: PipelineRunStepProgress | null): number | null {
  const fromActive = asFiniteInt(active?.queue?.ahead_count)
  if (fromActive != null) return fromActive
  for (const item of data.queueItems ?? []) {
    const count = asFiniteInt(item.ahead_count)
    if (count != null) return count
  }
  for (const line of queueLinesOf(data)) {
    const match = line.match(/前方还有[：:]\s*(\d+)/) || line.match(/前方\s*(\d+)\s*项/)
    if (match) return Number(match[1])
  }
  return null
}

function isWaitingInQueue(data: PipelineRunProgressPartData, active: PipelineRunStepProgress | null): boolean {
  if (data.status === 'pending') return true
  const queue = active?.queue
  if (queue) {
    const status = String(queue.status ?? queue.phase ?? queue.stage ?? '').toLowerCase()
    if (/(run|success|done|active)/.test(status)) return false
    if (/(queue|wait|pending)/.test(status)) return true
    const ahead = asFiniteInt(queue.ahead_count)
    if (ahead != null && ahead > 0) return true
  }
  return queueLinesOf(data).some((line) => /排队位置|前方还有/.test(line))
}

export function PipelineRunProgressBlock({ data }: { data: PipelineRunProgressPartData }) {
  if (data.phase === 'canvas') {
    return <CanvasProgressCard data={data} />
  }
  return <RunProgressCard data={data} />
}

function CanvasProgressCard({ data }: { data: PipelineRunProgressPartData }) {
  const done = data.status === 'success'
  const failed = data.status === 'failed'
  const title = done ? '画布模板已更新' : failed ? '改画布失败' : '正在改画布模板'
  return (
    <article className="pipeline-run-card" data-phase="canvas">
      <style>{progressStyles}</style>
      <header className="pipeline-run-head">
        <h3>{title}</h3>
        <span className={`pipeline-run-pill is-${failed ? 'fail' : done ? 'done' : 'run'}`}>
          {statusLabel(data.status, 'canvas')}
        </span>
      </header>
      <p className="pipeline-run-copy">{data.message || '正在根据需求修改工作流画布，还没有开始跑节点。'}</p>
      <div className={`pipeline-meter ${done || failed ? '' : 'is-indet'}`}>
        <i style={{ width: done || failed ? '100%' : '34%' }} />
      </div>
    </article>
  )
}

function RunProgressCard({ data }: { data: PipelineRunProgressPartData }) {
  const steps = data.steps ?? []
  const groups = groupPipelineRunSteps(steps)
  const active = currentStep(data, steps)
  const overall = overallProgress(steps)
  const overallPercent =
    overall != null
      ? Math.round(overall * 100)
      : typeof data.progress === 'number' && Number.isFinite(data.progress)
        ? Math.round(Math.min(1, Math.max(0, data.progress)) * 100)
        : null
  const queued = isWaitingInQueue(data, active)
  const ahead = aheadCountOf(data, active)
  const runningLabels = groups.filter((group) => ACTIVE_STATES.has(group.state)).map((group) => group.label)
  const activeName =
    runningLabels.length > 0
      ? runningLabels.join(' · ')
      : active
        ? displayStepLabel(active, Math.max(0, steps.indexOf(active)))
        : data.stepId || data.stepLabel
          ? displayStepLabel({ stepId: data.stepId || '', nodeId: data.stepLabel || '', state: data.status }, 0)
          : ''
  const stageIndex = groups.findIndex(
    (group) => ACTIVE_STATES.has(group.state) || group.state === 'awaiting_human' || group.state === 'awaiting_approval'
  )
  const stageLabel =
    groups.length > 0 && stageIndex >= 0
      ? `STAGE ${stageIndex + 1}/${groups.length}`
      : groups.length > 0
        ? `STAGE ${groups.length}/${groups.length}`
        : ''

  return (
    <article className="pipeline-run-card" data-phase="run">
      <style>{progressStyles}</style>
      <header className="pipeline-run-head">
        <h3>运行工作流 · {statusLabel(data.status, 'run')}</h3>
        <time>{formatElapsed(data.elapsedSeconds)}</time>
      </header>
      {groups.length > 0 ? (
        <div className="pipeline-run-meta">
          <span>整体进度{stageLabel ? ` · ${stageLabel}` : ''}</span>
          <span className="tabular-nums">{overallPercent != null ? `${overallPercent}%` : '进行中'}</span>
        </div>
      ) : null}
      {groups.length > 0 ? <NodeRail groups={groups} queued={queued} /> : null}
      <p className="pipeline-run-copy">
        {queued ? (
          ahead != null ? (
            <>
              排队中，前方 <b>{ahead}</b> 项
            </>
          ) : (
            '排队中'
          )
        ) : data.status === 'failed' ? (
          data.message || '失败'
        ) : data.status === 'cancelled' ? (
          '已取消'
        ) : DONE_STATES.has(data.status) || data.status === 'verified' || data.status === 'delivered' ? (
          '已完成'
        ) : activeName ? (
          <>
            <b>运行中</b> · {activeName}
          </>
        ) : (
          '运行中'
        )}
      </p>
    </article>
  )
}

function segmentFillWidth(group: PipelineRunStepGroup): number {
  if (DONE_STATES.has(group.state)) return 100
  if (group.state === 'failed') return 100
  if (ACTIVE_STATES.has(group.state) || group.state === 'awaiting_human' || group.state === 'awaiting_approval') {
    return Math.round(Math.max(0.08, Math.min(1, group.progress || 0.08)) * 100)
  }
  return 0
}

function groupTone(
  group: PipelineRunStepGroup,
  queued: boolean
): 'done' | 'run' | 'queue' | 'fail' | 'wait' | 'review' {
  if (group.state === 'failed') return 'fail'
  if (DONE_STATES.has(group.state)) return 'done'
  if (group.state === 'awaiting_human' || group.state === 'awaiting_approval') return 'review'
  if (ACTIVE_STATES.has(group.state) && queued) return 'queue'
  if (ACTIVE_STATES.has(group.state)) return 'run'
  return 'wait'
}

function groupStatusText(group: PipelineRunStepGroup, queued: boolean): string {
  if (group.state === 'failed') return '失败'
  if (DONE_STATES.has(group.state)) return '完成'
  if (group.state === 'awaiting_human' || group.state === 'awaiting_approval') return '待审核'
  if (ACTIVE_STATES.has(group.state) && queued) return '排队'
  if (ACTIVE_STATES.has(group.state)) {
    const percent = Math.round(Math.min(1, Math.max(0, group.progress)) * 100)
    return percent > 0 ? `${percent}%` : '进行中'
  }
  return '等待'
}

function NodeRail({ groups, queued }: { groups: PipelineRunStepGroup[]; queued: boolean }) {
  return (
    <ol className="pipeline-node-rail" aria-label="画布节点">
      {groups.map((group, index) => {
        const tone = groupTone(group, queued)
        const width = segmentFillWidth(group)
        return (
          <li key={group.key || index}>
            {index > 0 ? <span className="pipeline-node-join" aria-hidden="true" /> : null}
            <article
              className={`pipeline-node-chip is-${tone}`}
              aria-label={`${group.label}，${group.purpose}`}
              title={group.purpose}>
              <header>{group.label}</header>
              <div className="pipeline-node-meter">
                <i style={{ width: `${width}%` }} />
              </div>
              <footer>{groupStatusText(group, queued)}</footer>
            </article>
          </li>
        )
      })}
    </ol>
  )
}

const progressStyles = `
@keyframes pipeline-indet {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(380%); }
}
.pipeline-run-card {
  margin-top: 8px;
  border: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--card) 88%, #101114);
  padding: 12px;
  color: var(--foreground);
  font-size: 12px;
}
.pipeline-run-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pipeline-run-head h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
}
.pipeline-run-head time,
.pipeline-run-meta {
  color: var(--muted-foreground);
  font-size: 11px;
}
.pipeline-run-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}
.pipeline-run-pill {
  flex-shrink: 0;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
}
.pipeline-run-pill.is-run { background: color-mix(in srgb, #38bdf8 18%, transparent); color: #7dd3fc; }
.pipeline-run-pill.is-done { background: color-mix(in srgb, #2eb899 18%, transparent); color: #5eead4; }
.pipeline-run-pill.is-fail { background: color-mix(in srgb, #f87171 18%, transparent); color: #fca5a5; }
.pipeline-run-copy {
  margin: 10px 0 0;
  color: var(--muted-foreground);
  line-height: 1.45;
}
.pipeline-run-copy b { color: var(--foreground); font-weight: 600; }
.pipeline-meter,
.pipeline-node-meter {
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 70%, #24262e);
}
.pipeline-meter { margin-top: 8px; height: 8px; }
.pipeline-meter i,
.pipeline-node-meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #38bdf8;
}
.pipeline-meter.is-indet i { width: 34%; animation: pipeline-indet 1.2s ease-in-out infinite; }
.pipeline-node-rail {
  display: flex;
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  overflow-x: auto;
}
.pipeline-node-rail > li {
  display: flex;
  min-width: 0;
  flex: 1 1 0;
}
.pipeline-node-join {
  flex: 0 0 10px;
  height: 0;
  margin: 22px 0 0;
  border-top: 1px dashed color-mix(in srgb, var(--muted-foreground) 45%, transparent);
}
.pipeline-node-chip {
  min-width: 88px;
  flex: 1 1 0;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 72%, #14151a);
  box-shadow: inset 0 2px 0 0 var(--chip-accent, #64748b);
  padding: 8px 8px 7px;
}
.pipeline-node-chip header {
  overflow: hidden;
  font-size: 11px;
  font-weight: 650;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-node-chip footer {
  margin-top: 4px;
  color: var(--muted-foreground);
  font-size: 10px;
  line-height: 1.2;
}
.pipeline-node-meter { margin-top: 7px; height: 4px; }
.pipeline-node-chip.is-done { --chip-accent: #2eb899; }
.pipeline-node-chip.is-run { --chip-accent: #5eead4; }
.pipeline-node-chip.is-queue { --chip-accent: #fdba74; }
.pipeline-node-chip.is-fail { --chip-accent: #f87171; }
.pipeline-node-chip.is-review { --chip-accent: #38bdf8; }
.pipeline-node-chip.is-wait { --chip-accent: #52525b; }
.pipeline-node-chip.is-done .pipeline-node-meter i { background: #2eb899; }
.pipeline-node-chip.is-run .pipeline-node-meter i { background: linear-gradient(90deg, #2eb899, #73e6cc); }
.pipeline-node-chip.is-queue .pipeline-node-meter i { background: linear-gradient(90deg, #c2410c, #fdba74); }
.pipeline-node-chip.is-fail .pipeline-node-meter i { background: #f87171; }
.pipeline-node-chip.is-review .pipeline-node-meter i { background: #38bdf8; }
`

export function PipelineReviewBlock({ data }: { data: PipelineReviewPartData }) {
  const [closed, setClosed] = React.useState(() => Boolean(data.closed) || !data.url || isReviewDismissed(data.runId))

  React.useEffect(() => {
    if (Boolean(data.closed) || !data.url || isReviewDismissed(data.runId)) {
      markReviewDismissed(data.runId)
      setClosed(true)
    }
  }, [data.closed, data.runId, data.url])

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data
      if (!payload || typeof payload !== 'object') return
      if ((payload as { type?: string }).type !== 'ai-pipeline:review-done') return
      const runId = (payload as { run_id?: string }).run_id
      if (runId && data.runId && runId !== data.runId) return
      markReviewDismissed(data.runId || runId)
      setClosed(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [data.runId])

  if (closed || !data.url) return null

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
        <span className="font-medium text-foreground">{data.title || '人工审核'}</span>
        {data.stepId ? <span className="text-muted-foreground">{data.stepId}</span> : null}
      </div>
      <iframe
        title={data.title || 'pipeline review'}
        src={data.url}
        className="w-full bg-background"
        style={{ height: 'min(56vh, 560px)', minHeight: 360 }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      />
    </div>
  )
}

export default PipelineRunProgressBlock
