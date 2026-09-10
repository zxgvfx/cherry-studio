import { describe, expect, it } from 'vitest'

import type { LiteMentionItem } from '../agentChatLiteTypes'
import { applyLiteMention, filterLiteMentions, readLiteMentionTrigger, removeLiteMentionTrigger } from '../liteMentions'

const items: LiteMentionItem[] = [
  { id: 'n1', kind: 'node', label: 'Tripo 文生3D', insert: '/model.tripo3d', group: '画布节点', search: 'tripo' },
  { id: 's1', kind: 'skill', label: 'houdini-sop', insert: 'Use the houdini-sop skill.', group: 'Skill' },
  { id: 'm1', kind: 'mcp', label: 'houdini_get_scene_info', insert: '/mcp:houdini_get_scene_info', group: 'MCP 工具' },
  { id: 'f1', kind: 'file', label: 'concept.png', insert: '@concept.png', group: '文件' }
]

describe('liteMentions', () => {
  it('reads / and @ triggers after whitespace', () => {
    expect(readLiteMentionTrigger('请用 /tri', 7)).toEqual({ char: '/', query: 'tri', start: 3, end: 7 })
    expect(readLiteMentionTrigger('@con', 4)).toEqual({ char: '@', query: 'con', start: 0, end: 4 })
    expect(readLiteMentionTrigger('a/b', 3)).toBeNull()
  })

  it('filters slash items by label and insert', () => {
    const matched = filterLiteMentions(items, 'tripo')
    expect(matched.map((item) => item.id)).toEqual(['n1'])
    expect(filterLiteMentions(items, 'scene').map((item) => item.id)).toEqual(['m1'])
  })

  it('replaces the trigger with the inserted token', () => {
    const slash = readLiteMentionTrigger('请用 /tri', 7)
    expect(slash).toEqual({ char: '/', query: 'tri', start: 3, end: 7 })
    expect(applyLiteMention('请用 /tri', slash!, '/model.tripo3d')).toEqual({
      text: '请用 /model.tripo3d ',
      caret: 3 + '/model.tripo3d '.length
    })
    const mention = readLiteMentionTrigger('@con more', 4)
    expect(mention).toEqual({ char: '@', query: 'con', start: 0, end: 4 })
    expect(removeLiteMentionTrigger('@con more', mention!)).toEqual({
      text: ' more',
      caret: 0
    })
  })
})
