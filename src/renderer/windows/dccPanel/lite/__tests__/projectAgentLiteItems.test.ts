import type { CherryMessagePart, CherryUIMessage } from '@shared/data/types/message'
import { describe, expect, it } from 'vitest'

import { lastAgentText, projectAgentLiteItems } from '../projectAgentLiteItems'

function userMessage(id: string, text: string): CherryUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as CherryUIMessage
}

function assistantMessage(id: string, parts: CherryMessagePart[]): CherryUIMessage {
  return { id, role: 'assistant', parts } as CherryUIMessage
}

describe('projectAgentLiteItems', () => {
  it('projects user and assistant text', () => {
    const items = projectAgentLiteItems(
      [userMessage('u1', '你好'), assistantMessage('a1', [{ type: 'text', text: '收到' }])],
      {}
    )
    expect(items).toEqual([
      { kind: 'user', id: 'u1', text: '你好' },
      { kind: 'agent', id: 'a1-text', text: '收到' }
    ])
  })

  it('projects a pending tool approval card', () => {
    const items = projectAgentLiteItems(
      [
        assistantMessage('a1', [
          {
            type: 'dynamic-tool',
            toolName: 'stats_orders_tool',
            toolCallId: 'call-1',
            state: 'approval-requested',
            input: { region: '华东' },
            approval: { id: 'appr-1' }
          } as CherryMessagePart
        ])
      ],
      {}
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'approval',
      toolName: 'stats_orders_tool',
      status: 'pending',
      description: '允许 Agent 执行 stats_orders_tool',
      match: { approvalId: 'appr-1', messageId: 'a1', toolCallId: 'call-1' }
    })
  })

  it('projects user files and pipeline assets', () => {
    const items = projectAgentLiteItems(
      [
        {
          id: 'u1',
          role: 'user',
          parts: [
            { type: 'text', text: '转 GLB' },
            { type: 'file', filename: 'ref.png', mediaType: 'image/png', url: 'blob:ref' }
          ]
        } as CherryUIMessage,
        assistantMessage('a1', [
          {
            type: 'data-pipeline-asset',
            data: {
              assetId: 'm1',
              name: 'hero.glb',
              assetType: 'model/gltf-binary',
              downloadUrl: 'http://x/hero.glb',
              localPath: 'C:/Temp/hero.glb'
            }
          } as CherryMessagePart
        ])
      ],
      {}
    )
    expect(items[0]).toMatchObject({
      kind: 'user',
      text: '转 GLB',
      files: [{ name: 'ref.png', mediaType: 'image/png' }]
    })
    expect(items[1]).toMatchObject({
      kind: 'asset',
      asset: { assetId: 'm1', name: 'hero.glb', localPath: 'C:/Temp/hero.glb' }
    })
  })

  it('prefers overlay parts when present', () => {
    const items = projectAgentLiteItems([assistantMessage('a1', [{ type: 'text', text: '旧' }])], {
      a1: [{ type: 'text', text: '流式中' }]
    })
    expect(items[0]).toMatchObject({ kind: 'agent', text: '流式中' })
  })
})

describe('lastAgentText', () => {
  it('returns the latest assistant text', () => {
    expect(
      lastAgentText([
        { kind: 'user', id: 'u', text: 'q' },
        { kind: 'agent', id: 'a1', text: 'one' },
        { kind: 'agent', id: 'a2', text: 'two' }
      ])
    ).toBe('two')
  })
})
