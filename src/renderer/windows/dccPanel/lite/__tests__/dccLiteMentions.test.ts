import { describe, expect, it } from 'vitest'

import { buildDccLiteFileItems, buildDccLiteSlashItems } from '../dccLiteMentions'

describe('dccLiteMentions', () => {
  it('groups canvas nodes, skills, and MCP tools for slash', () => {
    const items = buildDccLiteSlashItems({
      nodes: [
        {
          node_id: 'model.tripo3d',
          name: 'Tripo 文生3D',
          description: '',
          tags: ['3d'],
          input_ports: [],
          output_ports: [],
          config_schema: []
        }
      ],
      skills: [{ name: 'houdini-sop', filename: 'houdini-sop', description: 'SOP' }],
      mcpTools: [{ name: 'houdini_get_scene_info', description: 'scene' }]
    })
    expect(items.map((item) => item.group)).toEqual(['画布节点', 'Skill', 'MCP 工具'])
    expect(items[0]?.insert).toBe('/model.tripo3d')
    expect(items[1]?.insert).toBe('Use the houdini-sop skill.')
    expect(items[2]?.insert).toBe('/mcp:houdini_get_scene_info')
  })

  it('always includes a local file picker in @ items', () => {
    const items = buildDccLiteFileItems([
      { assetId: 'a1', name: 'concept.png', kind: 'image', origin: 'upload', caption: '参考图', createdAt: 1 }
    ])
    expect(items[0]?.action).toBe('pick-file')
    expect(items[1]).toMatchObject({ label: 'concept.png', payload: { assetId: 'a1' } })
  })
})
