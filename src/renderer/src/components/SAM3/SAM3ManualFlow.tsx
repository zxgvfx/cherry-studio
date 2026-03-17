import React, { useCallback } from 'react'
import styled from 'styled-components'

import SAM3Annotator from './SAM3Annotator'

interface Props {
  imagePath: string
  onComplete: (modelFile: { id: string; name: string; path: string; ext: string; size: number }) => void
  onCancel: () => void
}

const SAM3ManualFlow: React.FC<Props> = ({ imagePath, onComplete, onCancel }) => {
  const handleComplete = useCallback(
    (files: Array<{ id: string; name: string; path: string; ext: string; size: number }>) => {
      if (files.length > 0) {
        onComplete(files[0])
      }
    },
    [onComplete]
  )

  return (
    <FlowContainer>
      <SAM3Annotator imagePath={imagePath} onComplete={handleComplete} onCancel={onCancel} />
    </FlowContainer>
  )
}

const FlowContainer = styled.div`
  width: 100%;
  height: 100%;
  min-height: 500px;
`

export default React.memo(SAM3ManualFlow)
