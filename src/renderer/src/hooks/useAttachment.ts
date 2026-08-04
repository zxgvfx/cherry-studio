import { loggerService } from '@logger'
import type { DiagramType } from '@renderer/components/Popups/DiagramPreviewPopup'
import DiagramPreviewPopup from '@renderer/components/Popups/DiagramPreviewPopup'
import File3DPreviewPopup from '@renderer/components/Popups/File3DPreviewPopup'
import type { Preview3DType } from '@renderer/components/Popups/File3DPreviewPopup'
import PdfPreviewPopup from '@renderer/components/Popups/PdfPreviewPopup'
import TextFilePreviewPopup from '@renderer/components/Popups/TextFilePreview'
import type { FileType } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('FileAction')

const DIAGRAM_EXT_MAP: Record<string, DiagramType> = {
  '.mmd': 'mermaid',
  '.mermaid': 'mermaid',
  '.dot': 'graphviz',
  '.gv': 'graphviz',
  '.puml': 'plantuml',
  '.plantuml': 'plantuml',
  '.pu': 'plantuml',
  '.svg': 'svg'
}

const POINT_CLOUD_EXTS = new Set(['.ply', '.pcd', '.las', '.laz', '.xyz', '.pts', '.e57'])
const MODEL_3D_EXTS = new Set(['.obj', '.stl', '.fbx', '.gltf', '.glb', '.usd', '.usda', '.usdc', '.usdz'])

function getDiagramType(ext?: string): DiagramType | null {
  if (!ext) return null
  const normalized = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  return DIAGRAM_EXT_MAP[normalized] ?? null
}

function get3DPreviewType(ext?: string): Preview3DType | null {
  if (!ext) return null
  const normalized = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  if (POINT_CLOUD_EXTS.has(normalized)) return 'point_cloud'
  if (MODEL_3D_EXTS.has(normalized)) return 'model_3d'
  return null
}

export function useAttachment() {
  const { t } = useTranslation()
  const preview = async (path: string, title: string, fileType: FileType, extension?: string) => {
    try {
      const ext = extension?.toLowerCase()

      const diagramType = getDiagramType(ext)
      if (diagramType) {
        DiagramPreviewPopup.show(path, title, diagramType)
        return
      }

      const preview3DType = get3DPreviewType(ext)
      if (preview3DType) {
        File3DPreviewPopup.show(title, preview3DType)
        return
      }

      if (ext === '.pdf' || ext === 'pdf') {
        PdfPreviewPopup.show(path, title)
        return
      }

      if (fileType === FILE_TYPE.TEXT) {
        const content = await window.api.fs.readText(path)
        let cleanExt = ext
        if (cleanExt?.startsWith('.')) {
          cleanExt = cleanExt.replace('.', '')
        }
        TextFilePreviewPopup.show(content, title, cleanExt)
        return
      }

      window.api.file.openPath(path)
    } catch (err) {
      logger.error(`Error opening ${path}:`, err as Error)
      window.modal.error({ content: t('files.preview.error'), centered: true })
    }
  }
  return {
    preview
  }
}
