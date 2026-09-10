import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../pipelineNodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pipelineNodes')>()
  return {
    ...actual,
    resolvePipelineApiBase: vi.fn(async () => 'http://pipeline.test')
  }
})

import { emptyCanvasDag, runCocoSessionCanvas } from '../cocoSessionCanvas'

describe('runCocoSessionCanvas', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects an empty canvas without calling the API', async () => {
    await expect(runCocoSessionCanvas(emptyCanvasDag(), 'sess-1')).rejects.toThrow('empty canvas')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the DAG with the session id so assets stay on the conversation', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ run_id: 'run-9', status: 'running' })
    })
    const graph = {
      nodes: { a: { step_id: 'a', node_id: 'model.text-to-image', config: {} } },
      edges: []
    }
    await expect(runCocoSessionCanvas(graph, 'sess-1')).resolves.toEqual({
      runId: 'run-9',
      status: 'running'
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://pipeline.test/api/workflows/runs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          dag: graph,
          reuse_unchanged: true,
          inputs: { __agent_session_id: 'sess-1' },
          tags: ['agent_session:sess-1'],
          workflow_id: 'sess-1'
        })
      })
    )
  })

  it('surfaces FastAPI detail text on failure', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ detail: '缺少输出节点 io.workflow-output' })
    })
    const graph = {
      nodes: { a: { step_id: 'a', node_id: 'model.text-to-image', config: {} } },
      edges: []
    }
    await expect(runCocoSessionCanvas(graph)).rejects.toThrow('缺少输出节点 io.workflow-output')
  })
})
