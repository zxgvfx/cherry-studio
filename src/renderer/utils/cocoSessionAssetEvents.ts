import type { CocoSessionAsset } from '@shared/ai/cocoSessionAssets'

export const COCO_SESSION_ASSET_INSERT_EVENT = 'coco-session-asset:insert'
export const COCO_SESSION_ASSET_DELETE_EVENT = 'coco-session-asset:delete'

export interface CocoSessionAssetInsertDetail {
  sessionId: string
  asset: CocoSessionAsset
}

export function insertCocoSessionAssetIntoComposer(detail: CocoSessionAssetInsertDetail): void {
  window.dispatchEvent(new CustomEvent<CocoSessionAssetInsertDetail>(COCO_SESSION_ASSET_INSERT_EVENT, { detail }))
}

export function removeCocoSessionAssetFromComposer(detail: CocoSessionAssetInsertDetail): void {
  window.dispatchEvent(new CustomEvent<CocoSessionAssetInsertDetail>(COCO_SESSION_ASSET_DELETE_EVENT, { detail }))
}
