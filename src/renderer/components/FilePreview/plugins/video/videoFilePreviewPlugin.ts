import { videoExts } from '@shared/utils/file'

import type { FilePreviewPlugin } from '../../types'

/** Houdini/fork customization: native `<video>` preview for attachments/generated
 * clips, ported alongside the image/3D/pdf/text preview plugins (see
 * `filePreviewRegistry.ts`). No transcoding here — relies on Chromium's built-in
 * codec support (H.264/VP8/VP9/AV1 depending on the Qt WebEngine build), same as
 * the old fork's video preview. */
export const videoFilePreviewPlugin = {
  id: 'video',
  extensions: videoExts.map((extension) => extension.slice(1)),
  load: () => import('./VideoFilePreview')
} satisfies FilePreviewPlugin
