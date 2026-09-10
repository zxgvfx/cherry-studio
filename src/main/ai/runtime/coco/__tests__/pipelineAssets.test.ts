import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  extractLatestRunAssetsFromEvents,
  extractRunAssets,
  isInlinePreviewRequest,
  pipelinePartFromSessionAsset,
  selectPreviewableSessionAssets
} from '../pipelineAssets'

describe('extractRunAssets', () => {
  it('extracts workflow products with preview and download URLs', () => {
    const assets = extractRunAssets({
      run: { run_id: 'run-1', status: 'success' },
      assets: [
        {
          id: 'ec608aec-c2b5-4248-b719-8f2bd59f4d6a',
          name: 'result_1787028190375.glb',
          asset_type: 'model/gltf-binary',
          size_bytes: 6_300_000
        }
      ]
    })

    expect(assets).toEqual([
      expect.objectContaining({
        assetId: 'ec608aec-c2b5-4248-b719-8f2bd59f4d6a',
        name: 'result_1787028190375.glb',
        runId: 'run-1',
        mimeType: 'model/gltf-binary'
      })
    ])
    expect(assets[0].downloadUrl).toContain('/api/assets/ec608aec-c2b5-4248-b719-8f2bd59f4d6a/file')
    expect(assets[0].previewUrl).toContain('/api/assets/ec608aec-c2b5-4248-b719-8f2bd59f4d6a/file')
  })

  it('renames generic model.glb from the producing Tripo step', () => {
    const assets = extractRunAssets({
      run: { run_id: 'run-tex', status: 'success' },
      assets: [
        {
          id: 'glb-tex',
          name: 'model.glb',
          asset_type: 'model/gltf-binary',
          source_step_id: 'tex/tex',
          source_node_id: 'model.tripo3d',
          metadata: { operation: 'texture' }
        }
      ]
    })
    expect(assets[0]?.name).toBe('textured.glb')
  })

  it('detects inline preview requests and prefers the latest generated model', () => {
    expect(isInlinePreviewRequest('运行完成了，预览刚刚的文件')).toBe(true)
    expect(isInlinePreviewRequest('hello canvas')).toBe(false)
    const selected = selectPreviewableSessionAssets([
      { assetId: 'img-1', name: 'shot.png', kind: 'image', origin: 'upload', caption: '上传' },
      {
        assetId: '23ef9791-063b-49aa-ad12-11a693e804c8',
        name: 'result_1787034237580.glb',
        kind: 'model',
        origin: 'generated',
        caption: '图生3D'
      }
    ])
    expect(selected).toEqual([
      expect.objectContaining({
        assetId: '23ef9791-063b-49aa-ad12-11a693e804c8',
        name: 'result_1787034237580.glb',
        assetType: 'model/gltf-binary'
      })
    ])
    expect(selected[0]?.previewUrl).toContain('/api/assets/23ef9791-063b-49aa-ad12-11a693e804c8/file')
  })

  it('restores a cached local path from the persisted session preview URL', () => {
    const localPath = path.resolve('package.json')
    const part = pipelinePartFromSessionAsset({
      assetId: 'glb-local',
      name: 'result.glb',
      kind: 'model',
      origin: 'generated',
      caption: '3D',
      previewUrl: pathToFileURL(localPath).href
    })

    expect(part.localPath).toBe(localPath)
  })

  it('does not treat uploaded originals as run products even when their ids appear in the prompt', () => {
    const upload = {
      assetId: '83edfc13-5fae-415a-90e8-6c48192cad3a',
      name: 'Snipaste_2026-01-15_11-25-12.png',
      kind: 'image' as const,
      origin: 'upload' as const,
      caption: '上传'
    }
    expect(
      selectPreviewableSessionAssets([upload], {
        mentionedIds: ['83edfc13-5fae-415a-90e8-6c48192cad3a']
      })
    ).toEqual([])
    expect(
      selectPreviewableSessionAssets([upload], {
        mentionedIds: ['83edfc13-5fae-415a-90e8-6c48192cad3a'],
        allowUploads: true
      })
    ).toEqual([expect.objectContaining({ assetId: '83edfc13-5fae-415a-90e8-6c48192cad3a' })])
  })

  it('reads the latest submit.graph products from session events', () => {
    expect(
      extractLatestRunAssetsFromEvents([
        { type: 'delta', data: { text: 'hi' } },
        {
          type: 'tool_result',
          data: {
            name: 'submit.graph',
            result: {
              run: { run_id: 'run-1' },
              assets: [{ id: 'glb-old', name: 'old.glb', asset_type: 'model/gltf-binary' }]
            }
          }
        },
        {
          type: 'tool_result',
          data: {
            name: 'submit.graph',
            result: {
              run: { run_id: 'run-2' },
              assets: [
                {
                  id: '23ef9791-063b-49aa-ad12-11a693e804c8',
                  name: 'result_1787034237580.glb',
                  asset_type: 'model/gltf-binary'
                }
              ]
            }
          }
        }
      ])
    ).toEqual([
      expect.objectContaining({
        assetId: '23ef9791-063b-49aa-ad12-11a693e804c8',
        runId: 'run-2'
      })
    ])
  })

  it('previews only the last producing node in a multi-step run', () => {
    expect(
      extractRunAssets({
        run: {
          run_id: 'run-1',
          status: 'success',
          steps: [
            { step_id: 'style', node_id: 'model.image-to-image', state: 'success' },
            { step_id: 'gate', node_id: 'human.approve', state: 'success' },
            { step_id: 'gen', node_id: 'pixal3d-image-to-3d', state: 'success' }
          ]
        },
        assets: [
          {
            id: 'img-style',
            name: 'styled.png',
            asset_type: 'media/image',
            source_node_id: 'model.image-to-image'
          },
          {
            id: 'glb-1',
            name: 'result.glb',
            asset_type: 'model/gltf-binary',
            source_node_id: 'pixal3d-image-to-3d'
          }
        ]
      })
    ).toEqual([
      expect.objectContaining({
        assetId: 'glb-1',
        name: 'result.glb',
        sourceNodeId: 'pixal3d-image-to-3d'
      })
    ])
  })

  it('previews the single generating node when that is the whole run', () => {
    expect(
      extractRunAssets({
        run: {
          run_id: 'run-2',
          status: 'success',
          steps: [{ step_id: 'style', node_id: 'model.image-to-image', state: 'success' }]
        },
        assets: [
          {
            id: 'img-style',
            name: 'styled.png',
            asset_type: 'media/image',
            source_node_id: 'model.image-to-image'
          }
        ]
      })
    ).toEqual([
      expect.objectContaining({
        assetId: 'img-style',
        name: 'styled.png'
      })
    ])
  })

  it('does not preview products of a rejected or failed run', () => {
    expect(
      extractRunAssets({
        run: { run_id: 'run-3', status: 'failed', error: '人工审阅驳回: 风格不对' },
        assets: [{ id: 'img-style', name: 'styled.png', asset_type: 'media/image' }]
      })
    ).toEqual([])
  })

  it('falls back to the last model when source node ids are missing', () => {
    expect(
      extractRunAssets({
        run: { run_id: 'run-4', status: 'success' },
        assets: [
          { id: 'img-style', name: 'styled.png', asset_type: 'media/image' },
          { id: 'glb-1', name: 'result.glb', asset_type: 'model/gltf-binary' }
        ]
      })
    ).toEqual([expect.objectContaining({ assetId: 'glb-1' })])
  })

  it('ignores asset lists that are not workflow run products', () => {
    expect(
      extractRunAssets({
        assets: [{ id: 'listed', name: 'orphan.glb', asset_type: 'model/gltf-binary' }]
      })
    ).toEqual([])
  })

  it('parses JSON string results and submit.graph payloads without a nested run object', () => {
    expect(
      extractRunAssets(
        JSON.stringify({
          run_id: 'run-2',
          assets: [{ id: 'asset-2', name: 'mesh.glb', asset_type: 'model/gltf-binary' }]
        }),
        { toolName: 'submit.graph' }
      )
    ).toEqual([
      expect.objectContaining({
        assetId: 'asset-2',
        name: 'mesh.glb',
        runId: 'run-2'
      })
    ])
  })
})
