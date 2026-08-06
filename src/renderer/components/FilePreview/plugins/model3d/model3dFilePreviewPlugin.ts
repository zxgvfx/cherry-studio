import type { FilePreviewPlugin } from '../../types'

export const model3dFilePreviewPlugin = {
  id: 'model3d',
  extensions: ['glb', 'gltf', 'fbx'],
  load: () => import('./Model3DFilePreview')
} satisfies FilePreviewPlugin
