import { describe, expect, it } from 'vitest'

import { CocoStreamAdapter, pipelineQuestionToAskUserInput } from '../cocoStreamAdapter'

function collect() {
  const chunks: unknown[] = []
  const adapter = new CocoStreamAdapter({ enqueue: (chunk) => chunks.push(chunk) })
  return { adapter, chunks }
}

describe('CocoStreamAdapter', () => {
  it('captures pipeline usage from the completed event', () => {
    const { adapter } = collect()
    expect(
      adapter.handleEvent({
        type: 'completed',
        data: { usage: { prompt_tokens: 12, completion_tokens: 4, cache_read_input_tokens: 3 } }
      })
    ).toBe('completed')
    expect(adapter.lastUsage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      noCacheTokens: 9,
      cacheReadTokens: 3,
      cacheWriteTokens: 0
    })
  })

  it('maps text deltas to UIMessageChunks', () => {
    const { adapter, chunks } = collect()
    expect(adapter.handleEvent({ type: 'delta', data: { text: 'hello' } })).toBe('continue')
    expect(adapter.handleEvent({ type: 'completed' })).toBe('completed')
    expect(chunks).toEqual([
      { type: 'text-start', id: expect.any(String) },
      { type: 'text-delta', id: expect.any(String), delta: 'hello' },
      { type: 'text-end', id: expect.any(String) }
    ])
    expect((chunks[0] as { id: string }).id).toBe((chunks[1] as { id: string }).id)
  })

  it('does not re-append a snapshot message after streamed deltas', () => {
    const { adapter, chunks } = collect()
    expect(adapter.handleEvent({ type: 'delta', data: { text: 'hello ' } })).toBe('continue')
    expect(adapter.handleEvent({ type: 'delta', data: { text: 'world' } })).toBe('continue')
    expect(adapter.handleEvent({ type: 'message', data: { role: 'assistant', content: 'hello world' } })).toBe(
      'continue'
    )
    expect(adapter.handleEvent({ type: 'completed' })).toBe('completed')
    const deltas = chunks.filter((chunk) => (chunk as { type?: string }).type === 'text-delta')
    expect(deltas).toEqual([
      expect.objectContaining({ type: 'text-delta', delta: 'hello ' }),
      expect.objectContaining({ type: 'text-delta', delta: 'world' })
    ])
  })

  it('uses a snapshot message when the pipeline did not stream deltas', () => {
    const { adapter, chunks } = collect()
    expect(adapter.handleEvent({ type: 'message', data: { role: 'assistant', content: 'done' } })).toBe('continue')
    expect(chunks).toEqual([
      { type: 'text-start', id: expect.any(String) },
      { type: 'text-delta', id: expect.any(String), delta: 'done' },
      { type: 'text-end', id: expect.any(String) }
    ])
  })

  it('maps graph_proposal to script.propose tool parts', () => {
    const { adapter, chunks } = collect()
    expect(
      adapter.handleEvent({
        type: 'graph_proposal',
        data: { description: 'add a node', unified_diff: 'diff' }
      })
    ).toBe('continue')
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-input-start', toolName: 'script.propose' }),
        expect.objectContaining({
          type: 'tool-input-available',
          toolName: 'script.propose',
          input: { description: 'add a node' }
        }),
        expect.objectContaining({
          type: 'tool-output-available',
          output: { description: 'add a node', unified_diff: 'diff' }
        }),
        expect.objectContaining({
          type: 'data-pipeline-run-progress',
          id: 'coco-pipeline-status',
          data: expect.objectContaining({
            phase: 'canvas',
            status: 'success',
            message: 'add a node'
          })
        })
      ])
    )
  })

  it('does not duplicate a graph_proposal emitted for an active script.propose call', () => {
    const { adapter, chunks } = collect()
    adapter.handleEvent({
      type: 'tool_started',
      data: {
        name: 'script.propose',
        tool_call_id: 'proposal-1',
        arguments: { description: 'add a node', script: 'node = example_echo()' }
      }
    })
    adapter.handleEvent({
      type: 'graph_proposal',
      data: { description: 'add a node', after_script: 'node = example_echo()' }
    })

    expect(
      chunks.filter(
        (chunk) =>
          (chunk as { type?: string; toolName?: string }).type === 'tool-input-start' &&
          (chunk as { toolName?: string }).toolName === 'script.propose'
      )
    ).toHaveLength(1)
    expect(chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool-output-available')).toHaveLength(0)

    adapter.handleEvent({
      type: 'tool_result',
      data: {
        name: 'script.propose',
        tool_call_id: 'proposal-1',
        result: { ok: true, applied: false, normalized_script: 'node = example_echo()' }
      }
    })
    expect(chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool-output-available')).toHaveLength(1)
  })

  it('returns pipeline errors for the connection to surface', () => {
    const { adapter } = collect()
    expect(adapter.handleEvent({ type: 'error', data: { message: 'boom' } })).toEqual({ error: 'boom' })
  })

  it('maps user_question to Cherry AskUserQuestion and pauses for an answer', () => {
    const { adapter, chunks } = collect()
    expect(
      adapter.handleEvent({
        type: 'tool_started',
        data: { name: 'interaction.ask_user', tool_call_id: 'ask-1', arguments: { question: '接下来往哪走？' } }
      })
    ).toBe('continue')
    expect(chunks).toEqual([])
    expect(
      adapter.handleEvent({
        type: 'tool_result',
        data: {
          name: 'interaction.ask_user',
          tool_call_id: 'ask-1',
          result: {
            ok: true,
            interaction: { type: 'user_question', question: '接下来往哪走？', options: ['A', 'B', 'C'] }
          }
        }
      })
    ).toBe('continue')
    expect(chunks).toEqual([])
    expect(
      adapter.handleEvent({
        type: 'user_question',
        data: {
          question: '接下来往哪走？',
          options: ['接图生3D', '换风格', '单独立绘', '调整后重跑', '导出'],
          allow_multiple: false
        }
      })
    ).toEqual({
      awaitingUser: {
        toolCallId: 'ask-1',
        input: expect.objectContaining({
          questions: [
            expect.objectContaining({
              question: '接下来往哪走？',
              header: '请选择',
              multiSelect: false,
              options: [
                { label: '接图生3D' },
                { label: '换风格' },
                { label: '单独立绘' },
                { label: '调整后重跑' },
                { label: '导出' },
                { label: '其他' }
              ]
            })
          ]
        })
      }
    })
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-input-start', toolCallId: 'ask-1', toolName: 'AskUserQuestion' }),
        expect.objectContaining({
          type: 'tool-input-available',
          toolCallId: 'ask-1',
          toolName: 'AskUserQuestion'
        })
      ])
    )
  })

  it('pads a single option so Cherry AskUserQuestion schema accepts it', () => {
    expect(pipelineQuestionToAskUserInput({ question: '继续吗？', options: ['是'] })).toEqual({
      questions: [
        {
          question: '继续吗？',
          header: '请选择',
          options: [{ label: '是' }, { label: '其他' }],
          multiSelect: false
        }
      ]
    })
  })

  it('appends a free-text option when the model only sent preset choices', () => {
    expect(pipelineQuestionToAskUserInput({ question: '提示词为空', options: ['继续', '取消'] })).toEqual({
      questions: [
        {
          question: '提示词为空',
          header: '请选择',
          options: [{ label: '继续' }, { label: '取消' }, { label: '其他' }],
          multiSelect: false
        }
      ]
    })
  })

  it('does not duplicate an existing free-text option', () => {
    expect(pipelineQuestionToAskUserInput({ question: 'q', options: ['A', '其他'] })).toEqual({
      questions: [
        {
          question: 'q',
          header: '请选择',
          options: [{ label: 'A' }, { label: '其他' }],
          multiSelect: false
        }
      ]
    })
  })

  it('emits preview tags and report_artifacts for workflow products', () => {
    const { adapter, chunks } = collect()
    expect(
      adapter.handleEvent({
        type: 'tool_result',
        data: {
          tool_call_id: 't-run',
          name: 'submit.graph',
          result: {
            run: { run_id: 'run-1', status: 'success' },
            assets: [
              {
                id: 'ec608aec-c2b5-4248-b719-8f2bd59f4d6a',
                name: 'result_1787028190375.glb',
                asset_type: 'model/gltf-binary',
                local_path: 'C:\\Users\\me\\.cherrystudio\\coco-assets\\ec608aec__result.glb',
                size_bytes: 6_300_000
              }
            ]
          }
        }
      })
    ).toBe('continue')

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-pipeline-asset',
          data: expect.objectContaining({
            assetId: 'ec608aec-c2b5-4248-b719-8f2bd59f4d6a',
            name: 'result_1787028190375.glb',
            localPath: 'C:\\Users\\me\\.cherrystudio\\coco-assets\\ec608aec__result.glb'
          })
        }),
        expect.objectContaining({
          type: 'tool-input-available',
          toolName: 'report_artifacts',
          input: expect.objectContaining({
            artifacts: [
              expect.objectContaining({
                path: 'C:\\Users\\me\\.cherrystudio\\coco-assets\\ec608aec__result.glb',
                description: 'result_1787028190375.glb'
              })
            ]
          })
        })
      ])
    )
  })

  it('does not emit report_artifacts until the product is cached locally', () => {
    const { adapter, chunks } = collect()
    adapter.handleEvent({
      type: 'tool_result',
      data: {
        tool_call_id: 't-run',
        name: 'submit.graph',
        result: {
          run: { run_id: 'run-1' },
          assets: [{ id: 'asset-1', name: 'result.glb', asset_type: 'model/gltf-binary' }]
        }
      }
    })
    expect(chunks.some((chunk) => (chunk as { type?: string }).type === 'data-pipeline-asset')).toBe(true)
    expect(
      chunks.some(
        (chunk) =>
          (chunk as { type?: string; toolName?: string }).type === 'tool-input-available' &&
          (chunk as { toolName?: string }).toolName === 'report_artifacts'
      )
    ).toBe(false)
  })

  it('presents session assets once and skips duplicates', () => {
    const { adapter, chunks } = collect()
    adapter.presentPipelineAssets([
      {
        assetId: 'glb-1',
        name: 'result.glb',
        assetType: 'model/gltf-binary',
        downloadUrl: 'http://pipeline/api/assets/glb-1/file',
        previewUrl: 'http://pipeline/api/model-viewer/assets/glb-1/preview.glb'
      }
    ])
    adapter.presentPipelineAssets([
      {
        assetId: 'glb-1',
        name: 'result.glb',
        assetType: 'model/gltf-binary',
        downloadUrl: 'http://pipeline/api/assets/glb-1/file'
      }
    ])
    const previewChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'data-pipeline-asset')
    expect(previewChunks).toHaveLength(1)
    expect(adapter.emittedPipelineAssets).toHaveLength(1)
  })

  it('maps run_progress to a stable progress card and HITL review iframe', () => {
    const { adapter, chunks } = collect()
    expect(
      adapter.handleEvent({
        type: 'run_progress',
        data: {
          phase: 'waiting',
          run: {
            run_id: 'run-hitl',
            status: 'awaiting_human',
            awaiting_step: 'review',
            interactive_url: '/review/?run_id=run-hitl',
            elapsed_seconds: 42,
            queue_label: '排队 2/5',
            queue_lines: ['节点：gen（pixal3d）', '排队位置：第 2 位', '前方还有：1 项'],
            summary: '当前执行：load(完成) → gen(运行中) | 排队任务：1 项',
            steps: [
              { step_id: 'load', node_id: 'data.load-video', state: 'success' },
              {
                step_id: 'review',
                node_id: 'human.approve',
                state: 'awaiting_human',
                progress_message: '等待确认'
              }
            ],
            current_step: {
              step_id: 'review',
              node_id: 'human.approve',
              state: 'awaiting_human',
              progress_message: '等待确认'
            }
          }
        }
      })
    ).toBe('continue')

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-pipeline-run-progress',
          id: 'coco-pipeline-status',
          data: expect.objectContaining({
            runId: 'run-hitl',
            status: 'awaiting_human',
            phase: 'run',
            stepLabel: 'human.approve',
            queue: expect.stringContaining('排队位置：第 2 位'),
            elapsedSeconds: 42,
            message: '等待确认',
            steps: expect.arrayContaining([
              expect.objectContaining({ stepId: 'load', state: 'success' }),
              expect.objectContaining({ stepId: 'review', state: 'awaiting_human' })
            ])
          })
        }),
        expect.objectContaining({
          type: 'data-pipeline-review',
          id: 'coco-run-review-run-hitl',
          data: expect.objectContaining({
            runId: 'run-hitl',
            url: expect.stringContaining('/review/?run_id=run-hitl')
          })
        })
      ])
    )

    adapter.handleEvent({
      type: 'run_progress',
      data: {
        run: {
          run_id: 'run-hitl',
          status: 'running',
          elapsed_seconds: 90,
          current_step: { step_id: 'gen', node_id: 'pixal3d', state: 'running', progress: 0.4 }
        }
      }
    })
    const progressChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'data-pipeline-run-progress')
    expect(progressChunks).toHaveLength(2)
    expect((progressChunks[0] as { id: string }).id).toBe((progressChunks[1] as { id: string }).id)
    const reviewChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'data-pipeline-review')
    expect(reviewChunks).toHaveLength(2)
    expect(reviewChunks[1]).toEqual(
      expect.objectContaining({
        id: 'coco-run-review-run-hitl',
        data: expect.objectContaining({ runId: 'run-hitl', closed: true, url: '' })
      })
    )
  })

  it('keeps still_running timeout results as progress, not failure', () => {
    const { adapter, chunks } = collect()
    adapter.handleEvent({
      type: 'tool_result',
      data: {
        tool_call_id: 't-wait',
        name: 'submit.graph',
        result: {
          timed_out: true,
          still_running: true,
          message: '运行仍在后台进行',
          run: {
            run_id: 'run-long',
            status: 'running',
            elapsed_seconds: 3600,
            current_step: { step_id: 'gen', node_id: 'pixal3d', state: 'running' }
          }
        }
      }
    })
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-pipeline-run-progress',
          data: expect.objectContaining({
            runId: 'run-long',
            timedOut: true,
            stillRunning: true,
            status: 'running',
            phase: 'run'
          })
        })
      ])
    )
  })

  it('shows a canvas-edit card as soon as script.propose starts', () => {
    const { adapter, chunks } = collect()
    adapter.handleEvent({
      type: 'tool_started',
      data: {
        tool_call_id: 't-canvas',
        name: 'script.propose',
        arguments: { description: '按视频生成 FBX 骨骼工作流' }
      }
    })
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-pipeline-run-progress',
          id: 'coco-pipeline-status',
          data: expect.objectContaining({
            phase: 'canvas',
            status: 'running',
            message: '按视频生成 FBX 骨骼工作流'
          })
        })
      ])
    )
  })

  it('shows a run card as soon as submit.graph starts', () => {
    const { adapter, chunks } = collect()
    expect(adapter.submittedGraphThisTurn).toBe(false)
    adapter.handleEvent({
      type: 'tool_started',
      data: { tool_call_id: 't-run', name: 'submit.graph', arguments: { graph: {} } }
    })
    expect(adapter.submittedGraphThisTurn).toBe(true)
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-pipeline-run-progress',
          id: 'coco-pipeline-status',
          data: expect.objectContaining({
            phase: 'run',
            status: 'pending',
            message: '正在提交并运行工作流…'
          })
        })
      ])
    )
  })

  it('pairs tool_result with tool_started when pipeline omits tool_call_id', () => {
    const { adapter, chunks } = collect()
    adapter.handleEvent({
      type: 'tool_started',
      data: { name: 'models.list', arguments: {} }
    })
    adapter.handleEvent({
      type: 'tool_result',
      data: { name: 'models.list', result: { providers: [] } }
    })
    const starts = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool-input-start')
    const outputs = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool-output-available')
    expect(starts).toHaveLength(1)
    expect(outputs).toHaveLength(1)
    expect((starts[0] as { toolCallId: string }).toolCallId).toBe((outputs[0] as { toolCallId: string }).toolCallId)
    expect((starts[0] as { toolName: string }).toolName).toBe('models.list')
  })

  it('ignores pipeline heartbeat keepalives without emitting UI chunks', () => {
    const { adapter, chunks } = collect()
    expect(adapter.handleEvent({ type: 'heartbeat' })).toBe('continue')
    expect(adapter.handleEvent({ type: 'delta', data: { text: 'ok' } })).toBe('continue')
    expect(adapter.handleEvent({ type: 'completed' })).toBe('completed')
    expect(chunks.filter((chunk) => (chunk as { type?: string }).type === 'text-delta')).toEqual([
      expect.objectContaining({ type: 'text-delta', delta: 'ok' })
    ])
  })
})
