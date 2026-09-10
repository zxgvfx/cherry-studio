import { describe, expect, it } from 'vitest'

import {
  captionForCocoGenerated,
  captionForCocoUpload,
  formatCocoAssetSize,
  mergeCocoSessionAssets,
  readCocoSessionAssets
} from '../cocoSessionAssets'

describe('cocoSessionAssets', () => {
  it('merges upload then generated without duplicating ids', () => {
    const merged = mergeCocoSessionAssets(
      [{ assetId: 'img-1', name: 'shot.png', origin: 'upload' }],
      [
        {
          assetId: 'glb-1',
          name: 'result.glb',
          origin: 'generated',
          workflowId: 'pixal3d-image-to-3d',
          parentAssetId: 'img-1'
        }
      ],
      [{ assetId: 'glb-1', name: 'result.glb', origin: 'generated' }]
    )
    expect(merged.map((item) => item.assetId)).toEqual(['img-1', 'glb-1'])
    expect(merged[0]?.caption).toBe(captionForCocoUpload('shot.png'))
    expect(merged[1]?.parentAssetId).toBe('img-1')
    expect(merged[1]?.caption).toContain('pixal3d-image-to-3d')
  })

  it('reads assets from coco_pipeline_sessions binding', () => {
    const assets = readCocoSessionAssets(
      {
        coco_pipeline_sessions: {
          'session-1': {
            id: 'pipe-1',
            assets: [{ assetId: 'img-1', name: 'shot.png', origin: 'upload' }]
          }
        }
      },
      'session-1'
    )
    expect(assets).toHaveLength(1)
    expect(assets[0]?.assetId).toBe('img-1')
    expect(readCocoSessionAssets({}, 'session-1')).toEqual([])
  })

  it('builds generated captions from workflow and source name', () => {
    expect(
      captionForCocoGenerated({
        name: 'result.glb',
        kind: 'model',
        workflowId: 'pixal3d-image-to-3d',
        sourceName: 'shot.png'
      })
    ).toBe('图生3D · pixal3d-image-to-3d · 来源 shot.png')
  })

  it('keeps size on the session asset card', () => {
    expect(formatCocoAssetSize(2048)).toBe('2 KB')
    const merged = mergeCocoSessionAssets(
      [{ assetId: 'vid-1', name: 'Download.mp4', origin: 'upload', sizeBytes: 4096 }],
      [{ assetId: 'vid-1', name: 'Download.mp4', origin: 'upload' }]
    )
    expect(merged[0]?.sizeBytes).toBe(4096)
  })

  it('fills previewUrl from a later generated snapshot of the same asset', () => {
    const merged = mergeCocoSessionAssets(
      [{ assetId: 'img-1', name: 'cat.png', origin: 'generated', kind: 'image' }],
      [
        {
          assetId: 'img-1',
          name: 'cat.png',
          origin: 'generated',
          kind: 'image',
          previewUrl: 'file:///tmp/cat.png',
          sizeBytes: 2048
        }
      ]
    )
    expect(merged[0]?.previewUrl).toBe('file:///tmp/cat.png')
    expect(merged[0]?.sizeBytes).toBe(2048)
  })
})
