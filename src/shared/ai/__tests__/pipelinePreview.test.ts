import { describe, expect, it } from 'vitest'

import { pipelineAssetDisplayName, pipelineAssetFileName } from '../pipelinePreview'

describe('pipelineAssetFileName', () => {
  it('renames generic Tripo GLBs from the producing step', () => {
    expect(
      pipelineAssetFileName({ name: 'model.glb', sourceStepId: 'tripo/gen3d', sourceNodeId: 'model.tripo3d' })
    ).toBe('geometry.glb')
    expect(pipelineAssetFileName({ name: 'model.glb', sourceStepId: 'tex/tex', operation: 'texture' })).toBe(
      'textured.glb'
    )
    expect(pipelineAssetFileName({ name: 'model.glb', sourceStepId: 'seg/seg' })).toBe('segmented.glb')
  })

  it('keeps already distinctive filenames', () => {
    expect(pipelineAssetFileName({ name: 'hero-turnaround.glb', sourceStepId: 'tex/tex' })).toBe('hero-turnaround.glb')
  })
})

describe('pipelineAssetDisplayName', () => {
  it('uses Chinese labels for the three Tripo stages', () => {
    expect(pipelineAssetDisplayName({ name: 'model.glb', sourceStepId: 'tripo/gen3d' })).toBe('几何模型.glb')
    expect(pipelineAssetDisplayName({ name: 'model.glb', sourceStepId: 'tex/tex' })).toBe('贴图模型.glb')
    expect(pipelineAssetDisplayName({ name: 'model.glb', sourceStepId: 'seg/seg' })).toBe('分割模型.glb')
  })
})
