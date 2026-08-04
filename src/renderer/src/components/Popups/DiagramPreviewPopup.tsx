import { loggerService } from '@logger'
import { GraphvizPreview, MermaidPreview, PlantUmlPreview, SvgPreview } from '@renderer/components/Preview'
import { Modal, Spin } from 'antd'
import { useEffect, useState } from 'react'
import styled from 'styled-components'

import { TopView } from '../TopView'

const logger = loggerService.withContext('DiagramPreviewPopup')

export type DiagramType = 'mermaid' | 'graphviz' | 'plantuml' | 'svg'

interface Props {
  filePath: string
  title: string
  diagramType: DiagramType
  resolve: (data: any) => void
}

const DiagramPreviewContainer: React.FC<Props> = ({ filePath, title, diagramType, resolve }) => {
  const [open, setOpen] = useState(true)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadContent = async () => {
      try {
        const text = await window.api.fs.readText(filePath)
        setContent(text)
      } catch (err) {
        logger.error(`Failed to read diagram file: ${filePath}`, err as Error)
        setError('Failed to read file')
      }
    }
    loadContent()
  }, [filePath])

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  DiagramPreviewPopup.hide = onCancel

  const renderDiagram = () => {
    if (error) {
      return <ErrorMessage>{error}</ErrorMessage>
    }

    if (content === null) {
      return (
        <LoadingContainer>
          <Spin size="large" />
        </LoadingContainer>
      )
    }

    switch (diagramType) {
      case 'mermaid':
        return <MermaidPreview enableToolbar>{content}</MermaidPreview>
      case 'graphviz':
        return <GraphvizPreview enableToolbar>{content}</GraphvizPreview>
      case 'plantuml':
        return <PlantUmlPreview enableToolbar>{content}</PlantUmlPreview>
      case 'svg':
        return <SvgPreview enableToolbar>{content}</SvgPreview>
      default:
        return <ErrorMessage>Unsupported diagram type: {diagramType}</ErrorMessage>
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      afterClose={onClose}
      title={title}
      width="80vw"
      transitionName="animation-move-down"
      styles={{
        content: {
          borderRadius: 20,
          padding: 0,
          overflow: 'hidden'
        },
        body: {
          height: '80vh',
          maxHeight: 'inherit',
          padding: 0,
          display: 'flex',
          flexDirection: 'column'
        }
      }}
      centered
      closable={true}
      footer={null}>
      <DiagramContainer>{renderDiagram()}</DiagramContainer>
    </Modal>
  )
}

const DiagramContainer = styled.div`
  width: 100%;
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px;
`

const LoadingContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
`

const ErrorMessage = styled.div`
  color: var(--color-error);
  padding: 24px;
  text-align: center;
`

const TopViewKey = 'DiagramPreviewPopup'

export default class DiagramPreviewPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(filePath: string, title: string, diagramType: DiagramType) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <DiagramPreviewContainer
          filePath={filePath}
          title={title}
          diagramType={diagramType}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
