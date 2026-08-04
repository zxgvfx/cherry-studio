import { useAssistant } from '@renderer/hooks/useAssistant'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import type { KnowledgeBase } from '@renderer/types'
import { useCallback } from 'react'

import KnowledgeBaseButton from './components/KnowledgeBaseButton'

/**
 * Knowledge Base Tool
 *
 * Allows users to select knowledge bases to provide context for their messages.
 */
const knowledgeBaseTool = defineTool({
  key: 'knowledge_base',
  label: (t) => t('chat.input.knowledge_base'),

  visibleInScopes: [TopicType.Chat],

  dependencies: {
    state: ['selectedKnowledgeBases', 'files'] as const,
    actions: ['setSelectedKnowledgeBases'] as const
  },

  render: function KnowledgeBaseToolRender(context) {
    const { assistant, state, actions, quickPanel } = context

    const { updateAssistant } = useAssistant(assistant.id)

    const handleSelect = useCallback(
      (bases: KnowledgeBase[]) => {
        updateAssistant({ knowledge_bases: bases })
        actions.setSelectedKnowledgeBases?.(bases)
      },
      [updateAssistant, actions]
    )

    return (
      <KnowledgeBaseButton
        quickPanel={quickPanel}
        selectedBases={state.selectedKnowledgeBases}
        onSelect={handleSelect}
        disabled={Array.isArray(state.files) && state.files.length > 0}
      />
    )
  }
})

registerTool(knowledgeBaseTool)

export default knowledgeBaseTool
