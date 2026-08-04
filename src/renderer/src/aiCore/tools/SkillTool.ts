import store from '@renderer/store'
import { selectEnabledSkills } from '@renderer/store/skills'
import { tool } from 'ai'
import * as z from 'zod'

import type { BuiltinTool } from './BuiltinToolRegistry'

export const skillBuiltinTool: BuiltinTool = {
  name: 'builtin_skill',
  isEnabled: () => {
    const skills = selectEnabledSkills(store.getState())
    return skills.length > 0
  },
  create: () => {
    const skills = selectEnabledSkills(store.getState())
    const skillList = skills.map((s) => `- "${s.name}": ${s.description}`).join('\n')

    return tool({
      description: `Execute a predefined skill/workflow. Available skills:\n${skillList}`,
      inputSchema: z.object({
        skillName: z.string().describe('Name of the skill to execute')
      }),
      execute: async ({ skillName }) => {
        const skill = skills.find((s) => s.name === skillName)
        if (!skill) {
          return { error: `Skill "${skillName}" not found` }
        }

        let content = skill.content || ''
        if (skill.filePath) {
          try {
            content = await window.api.file.readExternal(skill.filePath, true)
          } catch {
            return { error: `Failed to read skill file: ${skill.filePath}` }
          }
        }

        return { skill: skill.name, instructions: content }
      },
      toModelOutput: ({ output }) => ({
        type: 'content',
        value: [{ type: 'text', text: output.instructions || output.error || '' }]
      })
    })
  }
}
