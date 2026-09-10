import type { NormalToolResponse } from '@renderer/types/mcpTool'
import { setInlineFilePathHomePath } from '@renderer/utils/filePath'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageListProvider } from '../../../MessageListProvider'
import { defaultMessageRenderConfig, type MessageListProviderValue } from '../../../types'
import { MessageReportArtifacts } from '../ReportArtifacts'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'common.collapse') return 'Collapse'
      if (key === 'common.loading') return 'Loading'
      if (key === 'common.preview') return 'Preview'
      if (key === 'common.copied') return 'Copied'
      if (key === 'common.copy') return 'Copy'
      if (key === 'chat.input.tools.open_file') return 'Open File'
      if (key === 'chat.input.tools.open_file_error') return 'Failed to open file'
      if (key === 'chat.input.tools.open_with') return 'Open with'
      if (key === 'chat.input.tools.file_not_found') return 'File not found'
      if (key === 'agent.session.artifact.drag_hint') return 'Drag to Houdini / desktop'
      if (key === 'agent.session.artifact.drag_to_dcc') return 'Drag to DCC'
      if (key === 'agent.session.artifact.load_3d_preview') return 'Click to load 3D preview'
      if (key === 'agent.session.artifact.open_in_pane') return 'Open in file pane'
      if (key === 'agent.session.artifact.preview_unsupported') return 'Preview not supported'
      if (key === 'agent.session.file_manager.finder') return 'Finder'
      return key
    }
  })
}))

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />
}))

vi.mock('@renderer/components/FilePreview/plugins/model3d/GLBViewer', () => ({
  default: ({ src }: { src: string }) => <div data-testid="glb-viewer" data-src={src} />
}))

vi.mock('@renderer/utils/platform', () => ({
  isMac: true,
  isWin: false,
  platform: 'darwin'
}))

const renderWithProvider = (ui: ReactElement, actions: MessageListProviderValue['actions'] = {}) => {
  const value: MessageListProviderValue = {
    state: {
      topic: { id: 'topic-1', name: 'Topic' } as MessageListProviderValue['state']['topic'],
      messages: [],
      partsByMessageId: {},
      messageNavigation: 'none',
      estimateSize: 0,
      overscan: 0,
      loadOlderDelayMs: 0,
      loadingResetDelayMs: 0,
      renderConfig: defaultMessageRenderConfig
    },
    actions,
    meta: { selectionLayer: false }
  }

  return render(<MessageListProvider value={value}>{ui}</MessageListProvider>)
}

describe('MessageReportArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setInlineFilePathHomePath(undefined)
  })

  it('renders declared deliverables from tool arguments', () => {
    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-1',
            toolCallId: 'tool-call-1',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              summary: 'Created final outputs',
              artifacts: [{ path: 'dist/report.md', description: 'Report' }]
            },
            response: 'Recorded 1 artifact(s).'
          } as NormalToolResponse
        ]}
      />
    )

    expect(screen.getByRole('button', { name: 'Preview report.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Drag to DCC' })).toBeInTheDocument()
    expect(screen.getByTestId('artifact-preview-toggle')).toHaveTextContent('Preview')
    expect(screen.getByText('report.md')).toBeInTheDocument()
    expect(screen.queryByText('Created final outputs')).toBeNull()
    expect(screen.queryByText('- Report')).toBeNull()
  })

  it('shows a logical artifact filename instead of its UUID cache filename', () => {
    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-model',
            toolCallId: 'tool-call-model',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              artifacts: [
                {
                  path: 'C:\\cache\\d449d79f-a38b-45f8-a242-a1b68366447f',
                  description: 'model.glb'
                }
              ]
            }
          } as NormalToolResponse
        ]}
      />
    )

    expect(screen.getByText('model.glb')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview model.glb' })).toBeInTheDocument()
    expect(screen.queryByText('d449d79f-a38b-45f8-a242-a1b68366447f')).toBeNull()
  })

  it('disambiguates repeated model.glb cards from the same run', () => {
    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-models',
            toolCallId: 'tool-call-models',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              artifacts: [
                { path: 'C:\\cache\\a__model.glb', description: 'model.glb' },
                { path: 'C:\\cache\\b__model.glb', description: 'model.glb' },
                { path: 'C:\\cache\\c__model.glb', description: 'model.glb' }
              ]
            }
          } as NormalToolResponse
        ]}
      />
    )

    expect(screen.getByText('几何模型.glb')).toBeInTheDocument()
    expect(screen.getByText('贴图模型.glb')).toBeInTheDocument()
    expect(screen.getByText('分割模型.glb')).toBeInTheDocument()
    expect(screen.queryAllByText('model.glb')).toHaveLength(0)
  })

  it('uses the latest declaration for duplicate artifact paths', () => {
    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-1',
            toolCallId: 'tool-call-1',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              summary: 'First summary',
              artifacts: [{ path: 'dist/report.md', description: 'Draft' }]
            }
          } as NormalToolResponse,
          {
            id: 'tool-call-2',
            toolCallId: 'tool-call-2',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              summary: 'Final summary',
              artifacts: [{ path: 'dist/report.md', description: 'Final report' }]
            }
          } as NormalToolResponse
        ]}
      />
    )

    expect(screen.getAllByRole('button', { name: 'Preview report.md' })).toHaveLength(1)
    expect(screen.queryByText('Final summary')).toBeNull()
    expect(screen.queryByText('- Final report')).toBeNull()
    expect(screen.queryByText('- Draft')).toBeNull()
  })

  it('expands an inline preview instead of opening the file', async () => {
    const openArtifactFile = vi.fn().mockResolvedValue(undefined)
    const openPath = vi.fn().mockResolvedValue(undefined)

    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-1',
            toolCallId: 'tool-call-1',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              artifacts: [{ path: '/tmp/style.png' }]
            }
          } as NormalToolResponse
        ]}
      />,
      { openArtifactFile, openPath }
    )

    fireEvent.click(screen.getByTestId('artifact-preview-toggle'))
    expect(openArtifactFile).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
    expect(screen.getByTestId('artifact-inline-preview')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'style.png' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open with style.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open File' }))
    await waitFor(() => {
      expect(openPath).toHaveBeenCalledWith('/tmp/style.png')
    })
  })

  it('does not mount the GLB viewer until the user confirms 3D preview', async () => {
    const openArtifactFile = vi.fn()

    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-1',
            toolCallId: 'tool-call-1',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              artifacts: [{ path: '/tmp/result.glb' }]
            }
          } as NormalToolResponse
        ]}
      />,
      { openArtifactFile }
    )

    fireEvent.click(screen.getByTestId('artifact-preview-toggle'))
    expect(openArtifactFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('artifact-inline-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('glb-viewer')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Click to load 3D preview' }))
    expect(await screen.findByTestId('glb-viewer')).toBeInTheDocument()

    // Collapsing must unmount the viewer so its WebGL context is released.
    fireEvent.click(screen.getByTestId('artifact-preview-toggle'))
    expect(screen.queryByTestId('artifact-inline-preview')).toBeNull()
    expect(screen.queryByTestId('glb-viewer')).toBeNull()
  })

  it('unmounts a loaded GLB viewer when the host asks to release WebGL', async () => {
    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-1',
            toolCallId: 'tool-call-1',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              artifacts: [{ path: '/tmp/result.glb' }]
            }
          } as NormalToolResponse
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('artifact-preview-toggle'))
    fireEvent.click(screen.getByRole('button', { name: 'Click to load 3D preview' }))
    expect(await screen.findByTestId('glb-viewer')).toBeInTheDocument()

    window.dispatchEvent(new Event('coco:release-webgl'))
    await waitFor(() => {
      expect(screen.queryByTestId('glb-viewer')).toBeNull()
      expect(screen.queryByTestId('artifact-inline-preview')).toBeNull()
    })
  })

  it('resolves home-relative artifact paths before previewing or opening externally', async () => {
    const openArtifactFile = vi.fn().mockResolvedValue(undefined)
    const openPath = vi.fn().mockResolvedValue(undefined)
    setInlineFilePathHomePath('/Users/alice')

    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-1',
            toolCallId: 'tool-call-1',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              artifacts: [{ path: '~/Desktop/report.html' }]
            }
          } as NormalToolResponse
        ]}
      />,
      { openArtifactFile, openPath }
    )

    fireEvent.click(screen.getByRole('button', { name: 'Preview report.html' }))
    expect(openArtifactFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('artifact-inline-preview')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open with report.html' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open File' }))
    await waitFor(() => {
      expect(openPath).toHaveBeenCalledWith('/Users/alice/Desktop/report.html')
    })
  })

  it('runs artifact actions from the right-click context menu', async () => {
    const openPath = vi.fn().mockResolvedValue(undefined)
    const showInFolder = vi.fn().mockResolvedValue(undefined)
    const copyText = vi.fn().mockResolvedValue(undefined)

    renderWithProvider(
      <MessageReportArtifacts
        toolResponses={[
          {
            id: 'tool-call-1',
            toolCallId: 'tool-call-1',
            tool: { id: 'report-artifacts', name: 'report_artifacts', type: 'builtin' },
            status: 'done',
            arguments: {
              artifacts: [{ path: 'dist/report.md' }]
            }
          } as NormalToolResponse
        ]}
      />,
      { openPath, showInFolder, copyText }
    )

    const previewButton = screen.getByRole('button', { name: 'Preview report.md' })
    expect(previewButton).toHaveAttribute('aria-expanded', 'false')

    const openContextMenu = () => fireEvent.contextMenu(screen.getByText('report.md'))
    const contextMenu = () => within(screen.getByTestId('context-menu-content'))

    openContextMenu()
    fireEvent.click(contextMenu().getByRole('button', { name: 'Open File' }))
    openContextMenu()
    fireEvent.click(contextMenu().getByRole('button', { name: 'Finder' }))
    openContextMenu()
    fireEvent.click(contextMenu().getByRole('button', { name: 'Copy' }))

    await waitFor(() => {
      expect(openPath).toHaveBeenCalledWith('dist/report.md')
      expect(showInFolder).toHaveBeenCalledWith('dist/report.md')
      expect(copyText).toHaveBeenCalledWith('dist/report.md', { successMessage: 'Copied' })
    })
  })
})
