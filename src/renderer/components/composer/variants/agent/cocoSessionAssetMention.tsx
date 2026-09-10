import { FILE_TYPE, type FileType } from '@renderer/types/file'
import type { ComposerAttachment } from '@renderer/utils/message/composerAttachment'
import { pipelineAssetFileUrl } from '@renderer/utils/pipelineNodes'
import {
  type CocoSessionAsset,
  cocoSessionAssetPromptText,
  filterCocoSessionAssets
} from '@shared/ai/cocoSessionAssets'
import { getFileTypeByExt } from '@shared/utils/file'
import type { Editor } from '@tiptap/core'
import { Box, File } from 'lucide-react'
import type { ReactNode } from 'react'

import { serializeComposerDocument } from '../../composerDraft'
import type { ComposerSuggestionItem } from '../../quickPanel'
import { agentComposerTokenId, agentFileToComposerToken } from '../agentComposerTokens'

function fileTypeForAsset(asset: CocoSessionAsset): FileType {
  if (asset.kind === 'image') return FILE_TYPE.IMAGE
  if (asset.kind === 'video') return FILE_TYPE.VIDEO
  const ext = asset.name.includes('.') ? `.${asset.name.split('.').pop()}` : ''
  return ext ? getFileTypeByExt(ext) : FILE_TYPE.OTHER
}

export function cocoSessionAssetTokenSourceId(assetId: string): string {
  return `coco-asset-${assetId}`
}

function previewUrlForSessionAsset(asset: CocoSessionAsset): string | undefined {
  if (asset.previewUrl) return asset.previewUrl
  if (asset.kind === 'image' || asset.kind === 'video') return pipelineAssetFileUrl(asset.assetId)
  return undefined
}

export function sessionAssetToComposerAttachment(asset: CocoSessionAsset): ComposerAttachment {
  const ext = asset.name.includes('.') ? `.${asset.name.split('.').pop()}` : ''
  const previewUrl = previewUrlForSessionAsset(asset)
  return {
    fileTokenSourceId: cocoSessionAssetTokenSourceId(asset.assetId),
    name: asset.name,
    origin_name: asset.name,
    size: typeof asset.sizeBytes === 'number' && asset.sizeBytes > 0 ? asset.sizeBytes : 0,
    ext,
    type: fileTypeForAsset(asset),
    pipelineAssetId: asset.assetId,
    ...(previewUrl ? { previewUrl } : {})
  }
}

function assetThumb(asset: CocoSessionAsset): ReactNode {
  const previewUrl = previewUrlForSessionAsset(asset)
  if (asset.kind === 'image' && previewUrl) {
    return (
      <img
        src={previewUrl}
        alt=""
        width={16}
        height={16}
        style={{ objectFit: 'cover', borderRadius: 2, display: 'block' }}
      />
    )
  }
  if (asset.kind === 'model') return <Box size={16} />
  return <File size={16} />
}

export function buildCocoSessionAssetMentionItems(options: {
  assets: readonly CocoSessionAsset[]
  files: readonly ComposerAttachment[]
  setFiles: React.Dispatch<React.SetStateAction<ComposerAttachment[]>>
  query: string
  editor: Editor
}): ComposerSuggestionItem[] {
  const matched = filterCocoSessionAssets(options.assets, options.query)
  if (matched.length === 0) {
    return [
      {
        id: 'coco-session-asset:empty',
        label: '本会话还没有可引用的资产',
        description: '上传或生成文件后会出现在这里',
        disabled: true,
        command: () => undefined
      }
    ]
  }

  return matched.map((asset) => {
    const tokenFile = sessionAssetToComposerAttachment(asset)
    const token = {
      ...agentFileToComposerToken(tokenFile),
      promptText: cocoSessionAssetPromptText(asset)
    }
    const isSelectedFile = (currentFile: ComposerAttachment) =>
      currentFile.pipelineAssetId === asset.assetId || agentComposerTokenId.file(currentFile) === token.id

    return {
      id: `coco-session-asset:${asset.assetId}`,
      label: asset.name,
      description: asset.caption,
      icon: assetThumb(asset),
      filterText: `${asset.name} ${asset.caption} ${asset.assetId}`,
      disabled: options.files.some(isSelectedFile),
      command: ({ editor }: { editor: Editor }) => {
        const exists = serializeComposerDocument(editor).tokens.some((currentToken) => currentToken.id === token.id)
        if (!exists) {
          editor.chain().focus().insertComposerToken(token).insertContent(' ').run()
        }
        options.setFiles((prevFiles) => (prevFiles.some(isSelectedFile) ? prevFiles : [...prevFiles, tokenFile]))
      }
    }
  })
}
