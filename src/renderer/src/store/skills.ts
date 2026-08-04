import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { SkillConfig } from '@renderer/types'

export interface SkillsState {
  configs: SkillConfig[]
}

const initialState: SkillsState = {
  configs: []
}

const skillsSlice = createSlice({
  name: 'skills',
  initialState,
  reducers: {
    addSkill(state, action: PayloadAction<SkillConfig>) {
      state.configs.push(action.payload)
    },
    removeSkill(state, action: PayloadAction<string>) {
      state.configs = state.configs.filter((s) => s.id !== action.payload)
    },
    updateSkill(state, action: PayloadAction<SkillConfig>) {
      const index = state.configs.findIndex((s) => s.id === action.payload.id)
      if (index !== -1) {
        state.configs[index] = action.payload
      }
    },
    toggleSkill(state, action: PayloadAction<string>) {
      const skill = state.configs.find((s) => s.id === action.payload)
      if (skill) {
        skill.enabled = !skill.enabled
      }
    }
  }
})

export const { addSkill, removeSkill, updateSkill, toggleSkill } = skillsSlice.actions

export const selectEnabledSkills = (state: { skills: SkillsState }) =>
  state.skills.configs.filter((s) => s.enabled)

export const selectAllSkills = (state: { skills: SkillsState }) => state.skills.configs

export default skillsSlice.reducer
