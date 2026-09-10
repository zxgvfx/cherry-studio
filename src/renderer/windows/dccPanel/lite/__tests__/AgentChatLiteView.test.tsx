import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { LiteItem } from '../agentChatLiteTypes'
import { AgentChatLiteView } from '../AgentChatLiteView'

const pending: LiteItem[] = [
  { kind: 'user', id: 'u1', text: '查一下华东销售' },
  {
    kind: 'approval',
    id: 't1',
    toolName: 'stats_orders_tool',
    description: '允许 Agent 执行 stats_orders_tool',
    inputText: 'region=华东',
    status: 'pending',
    match: null
  }
]

describe('AgentChatLiteView', () => {
  it('renders a dark lite chat and MCP approval actions', async () => {
    const user = userEvent.setup()
    const onAllow = vi.fn()
    render(
      <AgentChatLiteView
        mode="embed"
        agentName="COCO"
        items={pending}
        sessions={[{ id: 's1', title: '新对话', time: '刚刚' }]}
        activeSessionId="s1"
        draft=""
        eventsOpen={false}
        reviewOpenId={null}
        historyOpen={false}
        isPending={false}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onAllow={onAllow}
        onDeny={() => undefined}
        onSelectSession={() => undefined}
        onToggleEvents={() => undefined}
        onToggleHistory={() => undefined}
        onToggleReview={() => undefined}
      />
    )
    expect(screen.getByText('智能助手')).toBeInTheDocument()
    expect(screen.getByText('允许 Agent 执行 stats_orders_tool')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '允许' }))
    expect(onAllow).toHaveBeenCalled()
  })

  it('keeps agent mode and model as separate pickers', async () => {
    const user = userEvent.setup()
    const onSelectMode = vi.fn()
    const onSelectModel = vi.fn()
    render(
      <AgentChatLiteView
        mode="embed"
        agentName="COCO AGENT"
        items={[]}
        sessions={[]}
        activeSessionId={null}
        draft=""
        eventsOpen={false}
        reviewOpenId={null}
        historyOpen={false}
        isPending={false}
        modes={[
          { id: 'agent', label: '代理', description: '改场景' },
          { id: 'plan', label: '规划', description: '只规划方案' }
        ]}
        modeId="agent"
        models={[
          { id: 'gpt-5', label: 'GPT-5' },
          { id: 'claude-sonnet', label: 'Claude Sonnet' }
        ]}
        modelId="gpt-5"
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onSelectSession={() => undefined}
        onToggleEvents={() => undefined}
        onToggleHistory={() => undefined}
        onToggleReview={() => undefined}
        onSelectMode={onSelectMode}
        onSelectModel={onSelectModel}
      />
    )
    expect(screen.getByRole('button', { name: 'Agent 模式' })).toHaveTextContent('代理')
    expect(screen.getByRole('button', { name: '模型' })).toHaveTextContent('GPT-5')
    await user.click(screen.getByRole('button', { name: 'Agent 模式' }))
    await user.click(screen.getByRole('button', { name: /规划/ }))
    expect(onSelectMode).toHaveBeenCalledWith('plan')
    await user.click(screen.getByRole('button', { name: '模型' }))
    await user.click(screen.getByRole('button', { name: 'Claude Sonnet' }))
    expect(onSelectModel).toHaveBeenCalledWith('claude-sonnet')
  })

  it('attaches dropped files and can import a pipeline asset', async () => {
    const user = userEvent.setup()
    const onPickFiles = vi.fn()
    const onImportAsset = vi.fn()
    render(
      <AgentChatLiteView
        mode="embed"
        agentName="COCO"
        items={[
          {
            kind: 'asset',
            id: 'glb',
            asset: { assetId: 'a1', name: 'hero.glb', assetType: 'model/gltf-binary' }
          }
        ]}
        sessions={[]}
        activeSessionId={null}
        draft=""
        eventsOpen={false}
        reviewOpenId={null}
        historyOpen={false}
        isPending={false}
        importLabel="Houdini"
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onSelectSession={() => undefined}
        onToggleEvents={() => undefined}
        onToggleHistory={() => undefined}
        onToggleReview={() => undefined}
        onPickFiles={onPickFiles}
        onImportAsset={onImportAsset}
      />
    )
    await user.click(screen.getByRole('button', { name: '导入到 Houdini' }))
    expect(onImportAsset).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '附件' }))
    expect(screen.getByText('hero.glb')).toBeInTheDocument()
  })

  it('keeps the dark lite chrome when the backend is down', () => {
    render(
      <AgentChatLiteView
        mode="embed"
        agentName="COCO"
        items={[]}
        sessions={[]}
        activeSessionId={null}
        draft=""
        eventsOpen={false}
        reviewOpenId={null}
        historyOpen={false}
        isPending={false}
        errorText="Headless Electron exited during startup (code 0)"
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onSelectSession={() => undefined}
        onToggleEvents={() => undefined}
        onToggleHistory={() => undefined}
        onToggleReview={() => undefined}
      />
    )
    expect(screen.getByText('智能助手')).toBeInTheDocument()
    expect(screen.getByText('Headless Electron exited during startup (code 0)')).toBeInTheDocument()
  })

  it('inserts slash nodes and at-file mentions from the composer', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onSelectMention = vi.fn()
    function Harness() {
      const [draft, setDraft] = useState('')
      return (
        <AgentChatLiteView
          mode="embed"
          agentName="COCO"
          items={[]}
          sessions={[]}
          activeSessionId={null}
          draft={draft}
          eventsOpen={false}
          reviewOpenId={null}
          historyOpen={false}
          isPending={false}
          slashItems={[
            {
              id: 'node:model.tripo3d',
              kind: 'node',
              label: 'Tripo 文生3D',
              insert: '/model.tripo3d',
              description: '/model.tripo3d',
              group: '画布节点'
            },
            {
              id: 'skill:houdini-sop',
              kind: 'skill',
              label: 'houdini-sop',
              insert: 'Use the houdini-sop skill.',
              group: 'Skill'
            }
          ]}
          fileItems={[
            {
              id: 'file:concept',
              kind: 'file',
              label: 'concept.png',
              insert: '@concept.png',
              group: '文件'
            }
          ]}
          onDraftChange={setDraft}
          onSend={onSend}
          onSelectMention={onSelectMention}
          onSelectSession={() => undefined}
          onToggleEvents={() => undefined}
          onToggleHistory={() => undefined}
          onToggleReview={() => undefined}
        />
      )
    }
    render(<Harness />)
    const composer = screen.getByPlaceholderText('输入 / 插入画布节点、Skill、MCP，@ 标记文件')
    await user.type(composer, '/tri')
    expect(screen.getByText('画布节点')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Tripo 文生3D/ })).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(composer).toHaveValue('/model.tripo3d ')
    expect(onSelectMention).toHaveBeenCalledWith(expect.objectContaining({ id: 'node:model.tripo3d' }))
    expect(onSend).not.toHaveBeenCalled()
    await user.clear(composer)
    await user.type(composer, '@con')
    expect(screen.getByText('文件')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(composer).toHaveValue('@concept.png ')
    expect(onSelectMention).toHaveBeenCalledWith(expect.objectContaining({ id: 'file:concept' }))
    expect(onSend).not.toHaveBeenCalled()
  })
})
