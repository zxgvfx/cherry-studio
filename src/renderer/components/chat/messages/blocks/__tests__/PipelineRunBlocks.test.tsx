import '@testing-library/jest-dom/vitest'

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { PipelineReviewBlock, PipelineRunProgressBlock } from '../PipelineRunBlocks'

describe('PipelineRunProgressBlock', () => {
  it('labels canvas editing instead of a workflow run', () => {
    render(
      <PipelineRunProgressBlock
        data={{
          runId: 'canvas',
          status: 'running',
          phase: 'canvas',
          message: '正在根据视频搭建 FBX 骨骼工作流'
        }}
      />
    )

    expect(screen.getByText('正在改画布模板')).toBeInTheDocument()
    expect(screen.getByText('正在根据视频搭建 FBX 骨骼工作流')).toBeInTheDocument()
    expect(screen.queryByText(/运行工作流/)).not.toBeInTheDocument()
  })

  it('keeps a single node rail and a one-line queue status', () => {
    render(
      <PipelineRunProgressBlock
        data={{
          runId: 'run-1',
          status: 'running',
          phase: 'run',
          stepId: 'gen',
          stepLabel: 'pixal3d',
          progress: 0.4,
          elapsedSeconds: 32,
          queuedCount: 2,
          summary: '当前执行：load(完成) → gen(运行中: 3D生成) → export(待运行) | 排队任务：2 项',
          queueLines: ['节点：gen（pixal3d）', '排队位置：第 2 位', '前方还有：1 项', '预计等待：40 秒'],
          steps: [
            { stepId: 'load', nodeId: 'data.load-video', state: 'success' },
            { stepId: 'gen', nodeId: 'pixal3d', state: 'running', progress: 0.4, message: '3D生成' },
            { stepId: 'export', nodeId: 'blender.export', state: 'pending' }
          ]
        }}
      />
    )

    expect(screen.getByText(/运行工作流/)).toBeInTheDocument()
    expect(screen.queryByText(/load\(完成\) → gen\(运行中: 3D生成\) → export\(待运行\)/)).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: '画布节点' })).toBeInTheDocument()
    expect(screen.getByText('加载视频')).toBeInTheDocument()
    expect(screen.getByText('图生3D')).toBeInTheDocument()
    expect(screen.getByText('导出')).toBeInTheDocument()
    expect(screen.getByText('完成')).toBeInTheDocument()
    expect(screen.getByText('排队')).toBeInTheDocument()
    expect(screen.getByText('等待')).toBeInTheDocument()
    expect(screen.getByLabelText(/加载视频/)).toBeInTheDocument()
    expect(screen.getByLabelText(/图生3D/)).toBeInTheDocument()
    expect(screen.getByLabelText(/导出/)).toBeInTheDocument()
    expect(screen.queryByText('排队位置：第 2 位')).not.toBeInTheDocument()
    expect(screen.getByText(/排队中，前方/)).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('reports the running step when the node is not in a remote queue', () => {
    render(
      <PipelineRunProgressBlock
        data={{
          runId: 'run-2',
          status: 'running',
          phase: 'run',
          stepId: 'gen',
          elapsedSeconds: 12,
          steps: [
            { stepId: 'load', nodeId: 'data.load-video', state: 'success' },
            { stepId: 'gen', nodeId: 'pixal3d', state: 'running', progress: 0.5 }
          ]
        }}
      />
    )

    expect(screen.getByText('运行中')).toBeInTheDocument()
    expect(screen.getByText(/· 图生3D/)).toBeInTheDocument()
    expect(screen.queryByText(/排队中/)).not.toBeInTheDocument()
  })

  it('groups flattened composite internals onto canvas nodes', () => {
    render(
      <PipelineRunProgressBlock
        data={{
          runId: 'run-flat',
          status: 'running',
          phase: 'run',
          stepId: 'seg/seg',
          elapsedSeconds: 90,
          steps: [
            { stepId: 'gen2', nodeId: 'model.text-to-image', state: 'success' },
            { stepId: 'tv/in', nodeId: 'io.workflow-input', state: 'success' },
            { stepId: 'tv/generate_sheet', nodeId: 'model.image-to-image', state: 'success' },
            { stepId: 'tv/split', nodeId: 'imgproc.split-three-view', state: 'success' },
            { stepId: 'tv/out', nodeId: 'io.workflow-output', state: 'success' },
            { stepId: 'tripo/in', nodeId: 'io.workflow-input', state: 'success' },
            { stepId: 'tripo/gen3d', nodeId: 'model.tripo3d', state: 'success' },
            { stepId: 'tripo/out', nodeId: 'io.workflow-output', state: 'success' },
            { stepId: 'tex/in', nodeId: 'io.workflow-input', state: 'success' },
            { stepId: 'tex/tex', nodeId: 'model.tripo3d', state: 'success' },
            { stepId: 'tex/out', nodeId: 'io.workflow-output', state: 'success' },
            { stepId: 'seg/in', nodeId: 'io.workflow-input', state: 'success' },
            { stepId: 'seg/seg', nodeId: 'model.tripo3d', state: 'running', progress: 0.4 },
            { stepId: 'seg/out', nodeId: 'io.workflow-output', state: 'pending' },
            { stepId: 'out', nodeId: 'io.workflow-output', state: 'pending' }
          ]
        }}
      />
    )

    expect(screen.getByText(/STAGE 5\/6/)).toBeInTheDocument()
    expect(screen.getByText('一致性三视图')).toBeInTheDocument()
    expect(screen.getByText('Tripo 生3D')).toBeInTheDocument()
    expect(screen.getByText('Tripo 贴图')).toBeInTheDocument()
    expect(screen.getByText('Tripo 分割')).toBeInTheDocument()
    expect(screen.getByLabelText(/一致性三视图/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tripo 生3D/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tripo 贴图/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tripo 分割/)).toBeInTheDocument()
    expect(screen.getByText(/· Tripo 分割/)).toBeInTheDocument()
    expect(screen.queryByText(/STAGE 13\/15/)).not.toBeInTheDocument()
  })
})

describe('PipelineReviewBlock', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('does not keep the review iframe after it is closed', () => {
    render(
      <PipelineReviewBlock
        data={{ runId: 'run-closed', url: 'http://pipeline/review/?run_id=run-closed', closed: true }}
      />
    )
    expect(screen.queryByTitle('pipeline review')).not.toBeInTheDocument()
    expect(screen.queryByText('人工审核')).not.toBeInTheDocument()
  })

  it('closes immediately when the review shell reports it is done', () => {
    render(<PipelineReviewBlock data={{ runId: 'run-done', url: 'http://pipeline/review/?run_id=run-done' }} />)
    expect(screen.getByTitle('pipeline review')).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'ai-pipeline:review-done', run_id: 'run-done', action: 'approve' }
        })
      )
    })
    expect(screen.queryByTitle('pipeline review')).not.toBeInTheDocument()
  })

  it('stays gone after remount once the review was submitted', () => {
    const { unmount } = render(
      <PipelineReviewBlock data={{ runId: 'run-persist', url: 'http://pipeline/review/?run_id=run-persist' }} />
    )
    expect(screen.getByTitle('pipeline review')).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'ai-pipeline:review-done', run_id: 'run-persist', action: 'reject' }
        })
      )
    })
    unmount()
    render(<PipelineReviewBlock data={{ runId: 'run-persist', url: 'http://pipeline/review/?run_id=run-persist' }} />)
    expect(screen.queryByTitle('pipeline review')).not.toBeInTheDocument()
  })
})
