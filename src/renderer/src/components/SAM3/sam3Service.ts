function getBackendBaseUrl(): string {
  return window.location.origin
}

export interface SAM3Status {
  plugin_id: string
  sam3_server: { url: string; available: boolean }
  gen3d_server: { url: string; available: boolean }
}

export interface SAM3LaunchResult {
  status: string
  session_id: string
  error?: string
}

export interface SAM3SessionStatus {
  session_id: string
  status: string
  masks: Array<{
    id: string
    name: string
    path: string
    ext: string
  }>
  preview_path?: string
  preview_id?: string
  error?: string
}

export interface SAM3Generate3DResult {
  ok?: boolean
  file?: {
    id: string
    name: string
    path: string
    ext: string
    size: number
    type: string
  }
  format?: string
  error?: string
}

export async function checkSAM3Status(): Promise<SAM3Status> {
  const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/status`)
  return resp.json()
}

export async function launchManualMode(imagePath: string): Promise<SAM3LaunchResult> {
  const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/launch-manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_path: imagePath })
  })
  return resp.json()
}

export async function getSessionStatus(sessionId: string): Promise<SAM3SessionStatus> {
  const resp = await fetch(
    `${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/session-status?session_id=${sessionId}`
  )
  return resp.json()
}

export async function generate3D(
  imagePath: string,
  maskPath: string,
  format: string = 'glb'
): Promise<SAM3Generate3DResult> {
  const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/generate-3d`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_path: imagePath, mask_path: maskPath, format })
  })
  return resp.json()
}

export async function autoSegment(
  imagePath: string,
  target: string
): Promise<{ status: string; message?: string; error?: string }> {
  const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/auto-segment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_path: imagePath, target })
  })
  return resp.json()
}

export interface SAM3SetImageResult {
  ok?: boolean
  session_id?: string
  error?: string
}

export interface SAM3PredictResult {
  ok?: boolean
  mask_b64?: string
  iou?: number
  pixels?: number
  ratio?: number
  error?: string
}

export interface SAM3ServeImageResult {
  ok?: boolean
  data_url?: string
  width?: number
  height?: number
  error?: string
}

export interface SAM3SaveMasksResult {
  ok?: boolean
  masks?: Array<{ id: string; name: string; path: string; ext: string }>
  error?: string
}

export async function setImage(imagePath: string, sessionId?: string): Promise<SAM3SetImageResult> {
  const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/set-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_path: imagePath, session_id: sessionId })
  })
  return resp.json()
}

export async function predict(
  points: number[][],
  labels: number[]
): Promise<SAM3PredictResult> {
  const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points, labels })
  })
  return resp.json()
}

export async function serveImage(imagePath: string): Promise<SAM3ServeImageResult> {
  const resp = await fetch(
    `${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/serve-image?path=${encodeURIComponent(imagePath)}`
  )
  return resp.json()
}

export async function saveMasks(
  masks: Array<{ name: string; mask_b64: string }>,
  sessionId?: string
): Promise<SAM3SaveMasksResult> {
  const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/sam3-segmentation/save-masks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masks, session_id: sessionId })
  })
  return resp.json()
}
