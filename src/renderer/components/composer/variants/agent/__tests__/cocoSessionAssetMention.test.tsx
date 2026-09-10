import { FILE_TYPE } from '@renderer/types/file'
import type { ComposerAttachment } from '@renderer/utils/message/composerAttachment'
import type { CocoSessionAsset } from '@shared/ai/cocoSessionAssets'
import { describe, expect, it, vi } from 'vitest'

import { buildCocoSessionAssetMentionItems, sessionAssetToComposerAttachment } from '../cocoSessionAssetMention'

const imageAsset: CocoSessionAsset = {
  assetId: 'img-1',
  name: 'shot.png',
  kind: 'image',
  origin: 'upload',
  caption: '上传 · shot.png',
  previewUrl: 'file:///tmp/shot.png'
}

const modelAsset: CocoSessionAsset = {
  assetId: 'glb-1',
  name: 'result.glb',
  kind: 'model',
  origin: 'generated',
  caption: '图生3D · pixal3d-image-to-3d · 来源 shot.png'
}

const editor = {
  chain: () => ({ focus: () => ({ insertComposerToken: vi.fn(), insertContent: vi.fn(), run: vi.fn() }) })
} as never

describe('coco session asset @ mention', () => {
  it('lists only current-session assets with thumbnails and pipeline ids', () => {
    const items = buildCocoSessionAssetMentionItems({
      assets: [imageAsset, modelAsset],
      files: [],
      setFiles: vi.fn(),
      query: '',
      editor
    })
    expect(items.map((item) => item.id)).toEqual(['coco-session-asset:img-1', 'coco-session-asset:glb-1'])
    expect(items[0]?.description).toBe('上传 · shot.png')
    expect(items[0]?.icon).toBeTruthy()
    expect(items[1]?.icon).toBeTruthy()

    const attachment = sessionAssetToComposerAttachment(imageAsset)
    expect(attachment.pipelineAssetId).toBe('img-1')
    expect(attachment.type).toBe(FILE_TYPE.IMAGE)
    expect(attachment.previewUrl).toBe('file:///tmp/shot.png')
    expect(attachment.fileTokenSourceId).toBe('coco-asset-img-1')
    expect(attachment.size).toBe(0)
  })

  it('fills size and pipeline file preview for generated images that only have an asset id', () => {
    const generated: CocoSessionAsset = {
      assetId: '2a6f2ead-5659-4322-b097-57bf5d640b74',
      name: 'model-img-l6pn61yp.png',
      kind: 'image',
      origin: 'generated',
      caption: '生图 · model.text-to-image · model-img-l6pn61yp.png',
      sizeBytes: 184320
    }
    const attachment = sessionAssetToComposerAttachment(generated)
    expect(attachment.size).toBe(184320)
    expect(attachment.type).toBe(FILE_TYPE.IMAGE)
    expect(attachment.previewUrl).toBe(
      'http://192.168.21.225:9331/api/assets/2a6f2ead-5659-4322-b097-57bf5d640b74/file'
    )
  })

  it('filters by caption and returns empty-state when nothing matches', () => {
    const empty = buildCocoSessionAssetMentionItems({
      assets: [imageAsset],
      files: [],
      setFiles: vi.fn(),
      query: 'zzz-not-here',
      editor
    })
    expect(empty[0]?.id).toBe('coco-session-asset:empty')
    expect(empty[0]?.disabled).toBe(true)

    const filtered = buildCocoSessionAssetMentionItems({
      assets: [imageAsset, modelAsset],
      files: [],
      setFiles: vi.fn(),
      query: '图生3D',
      editor
    })
    expect(filtered.map((item) => item.id)).toEqual(['coco-session-asset:glb-1'])
  })

  it('disables an asset already attached in the composer', () => {
    const files: ComposerAttachment[] = [sessionAssetToComposerAttachment(imageAsset)]
    const items = buildCocoSessionAssetMentionItems({
      assets: [imageAsset],
      files,
      setFiles: vi.fn(),
      query: '',
      editor
    })
    expect(items[0]?.disabled).toBe(true)
  })
})
