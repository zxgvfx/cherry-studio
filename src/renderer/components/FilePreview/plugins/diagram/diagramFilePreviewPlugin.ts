import type { FilePreviewPlugin } from '../../types'

export const diagramFilePreviewPlugin = {
  id: 'diagram',
  // `.svg` is intentionally excluded — it's already owned by imageFilePreviewPlugin
  // (rendered directly via `<img>`), and filePreviewRegistry rejects duplicate
  // extension registrations.
  extensions: ['mmd', 'mermaid', 'dot', 'gv', 'puml', 'plantuml', 'iuml'],
  load: () => import('./DiagramFilePreview')
} satisfies FilePreviewPlugin
