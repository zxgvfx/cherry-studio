import { describe, expect, it } from 'vitest'

import {
  addCanvasNode,
  canvasFromPipelineSession,
  defaultPortsForConnection,
  incomingEdge,
  makeCanvasStepId,
  parseCanvasDag,
  removeCanvasEdge,
  removeCanvasNode,
  updateCanvasNodeConfig,
  upsertCanvasEdge
} from '../cocoSessionCanvas'
import { normalizePipelineNodeCatalogItem } from '../pipelineNodes'

const sourceNode = normalizePipelineNodeCatalogItem({
  node_id: 'model.text-to-image',
  name: 'Text to Image',
  description: '',
  tags: [],
  input_ports: [{ name: 'prompt', direction: 'input', asset_type: 'text', required: true, description: '', tags: [] }],
  output_ports: [
    {
      name: 'image_asset_id',
      direction: 'output',
      asset_type: 'asset/image',
      required: true,
      description: '',
      tags: []
    }
  ],
  config_schema: []
})!

const targetNode = normalizePipelineNodeCatalogItem({
  node_id: 'model.image-to-image',
  name: 'Image to Image',
  description: '',
  tags: [],
  input_ports: [
    {
      name: 'image_asset_id',
      direction: 'input',
      asset_type: 'asset/image',
      required: true,
      description: '',
      tags: []
    },
    { name: 'prompt', direction: 'input', asset_type: 'text', required: false, description: '', tags: [] }
  ],
  output_ports: [
    {
      name: 'image_asset_id',
      direction: 'output',
      asset_type: 'asset/image',
      required: true,
      description: '',
      tags: []
    }
  ],
  config_schema: []
})!

describe('cocoSessionCanvas', () => {
  it('parses graph_baseline from a pipeline session snapshot', () => {
    const snapshot = canvasFromPipelineSession(
      {
        id: 'pipe-1',
        revision: 3,
        context: {
          graph: { representation: 'pipeline_script', script: 'a = model_text_to_image()' },
          metadata: {
            graph_baseline: {
              nodes: { a: { step_id: 'a', node_id: 'model.text-to-image', config: { model: 'nano' } } },
              edges: [{ source_step: 'a', source_port: 'image_asset_id', target_step: 'b', target_port: 'image' }]
            }
          }
        }
      },
      'pipe-1'
    )
    expect(snapshot.revision).toBe(3)
    expect(snapshot.script).toContain('model_text_to_image')
    expect(snapshot.graph.nodes.a?.node_id).toBe('model.text-to-image')
    expect(snapshot.graph.edges).toHaveLength(1)
  })

  it('unwraps a workflow-shaped graph_baseline', () => {
    const snapshot = canvasFromPipelineSession(
      {
        context: {
          metadata: {
            graph_baseline: {
              id: 'generated-workflow',
              version: '0.0.0',
              dag: {
                nodes: {
                  generate: {
                    step_id: 'generate',
                    node_id: 'model.image-to-image',
                    config: { model: 'nano-banana-2' }
                  }
                },
                edges: []
              }
            }
          }
        }
      },
      'pipe-2'
    )

    expect(snapshot.graph.nodes.generate?.node_id).toBe('model.image-to-image')
  })

  it('adds, wires, edits, and removes nodes without mutating the original graph', () => {
    const original = parseCanvasDag({
      nodes: { a: { step_id: 'a', node_id: 'model.text-to-image', config: {} } },
      edges: []
    })
    const withNode = addCanvasNode(original, 'model.image-to-image')
    expect(Object.keys(original.nodes)).toEqual(['a'])
    expect(Object.keys(withNode.graph.nodes).sort()).toEqual(['a', 'model_image_to_image'])
    expect(withNode.stepId).toBe('model_image_to_image')

    const edited = updateCanvasNodeConfig(withNode.graph, 'a', { model: 'nano-banana-pro' })
    expect(edited.nodes.a?.config).toEqual({ model: 'nano-banana-pro' })
    expect(withNode.graph.nodes.a?.config).toEqual({})

    const wired = upsertCanvasEdge(edited, {
      source_step: 'a',
      source_port: 'image_asset_id',
      target_step: 'model_image_to_image',
      target_port: 'image_asset_id'
    })
    expect(incomingEdge(wired, 'model_image_to_image', 'image_asset_id')?.source_step).toBe('a')
    expect(
      removeCanvasEdge(wired, { target_step: 'model_image_to_image', target_port: 'image_asset_id' }).edges
    ).toEqual([])
    expect(removeCanvasNode(wired, 'model_image_to_image').nodes).toEqual({
      a: { step_id: 'a', node_id: 'model.text-to-image', config: { model: 'nano-banana-pro' } }
    })
  })

  it('picks default ports from the catalog and keeps generated step ids unique', () => {
    expect(
      defaultPortsForConnection(
        { step_id: 'a', node_id: sourceNode.node_id, config: {} },
        { step_id: 'b', node_id: targetNode.node_id, config: {} },
        [sourceNode, targetNode],
        new Set()
      )
    ).toEqual({ source_port: 'image_asset_id', target_port: 'image_asset_id' })
    expect(makeCanvasStepId('model.text-to-image', new Set(['model_text_to_image']))).toBe('model_text_to_image_2')
  })
})
