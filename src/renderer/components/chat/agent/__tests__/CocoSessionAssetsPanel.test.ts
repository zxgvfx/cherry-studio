import type { CherryMessagePart, CherryUIMessage } from '@shared/data/types/message'
import { describe, expect, it } from 'vitest'

import { assetsForTurn, turnForMessage } from '../CocoSessionAssetsPanel'

describe('CocoSessionAssetsPanel turn scope', () => {
  const messages = [
    { id: 'user-1', role: 'user' },
    { id: 'assistant-1', role: 'assistant', parentId: 'user-1' },
    { id: 'user-2', role: 'user' },
    { id: 'assistant-2', role: 'assistant', parentId: 'user-2' },
    { id: 'user-3', role: 'user' },
    { id: 'assistant-3', role: 'assistant', parentId: 'user-3' }
  ] as CherryUIMessage[]

  it('maps either side of a visible exchange to the same numbered turn', () => {
    expect(turnForMessage(messages, 'user-3')).toEqual({
      messageIds: new Set(['user-3', 'assistant-3']),
      number: 3
    })
    expect(turnForMessage(messages, 'assistant-3')).toEqual({
      messageIds: new Set(['user-3', 'assistant-3']),
      number: 3
    })
  })

  it('collects asset and run ids only from the active turn', () => {
    const partsByMessageId = {
      'assistant-2': [
        {
          type: 'data-pipeline-run-progress',
          data: { runId: 'run-2', status: 'success' }
        },
        {
          type: 'data-pipeline-asset',
          data: {
            assetId: 'glb-2',
            runId: 'run-2',
            name: 'model.glb',
            assetType: 'model/gltf-binary',
            downloadUrl: 'http://pipeline/glb-2'
          }
        }
      ] as CherryMessagePart[],
      'assistant-3': [
        {
          type: 'data-pipeline-asset',
          data: {
            assetId: 'glb-3',
            runId: 'run-3',
            name: 'model.glb',
            assetType: 'model/gltf-binary',
            downloadUrl: 'http://pipeline/glb-3'
          }
        }
      ] as CherryMessagePart[]
    }

    expect(assetsForTurn(partsByMessageId, new Set(['user-2', 'assistant-2']))).toEqual({
      assetIds: new Set(['glb-2']),
      runIds: new Set(['run-2'])
    })
  })
})
