import * as THREE from 'three'
// @ts-ignore - three subpath import; resolved correctly by bundler at runtime
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment'
// @ts-ignore
import dracoDecoderUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.js?url'
// @ts-ignore
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'

const STILL_SIZE = 256
const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()
let queue: Promise<void> = Promise.resolve()

export function canCaptureModelStill(name: string): boolean {
  return /\.(glb|gltf)(\?|#|$)/i.test(name)
}

function dracoDecoderDirectory(): string {
  try {
    return new URL('.', dracoDecoderUrl).href
  } catch {
    return 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/'
  }
}

function cherryBackendOrigin(): string {
  try {
    return ((window as Window & { __CHERRY_BACKEND_URL?: string }).__CHERRY_BACKEND_URL || '').replace(/\/$/, '')
  } catch {
    return ''
  }
}

function fileUrlToServePath(src: string): string | null {
  if (!src.startsWith('file:')) return null
  try {
    const parsed = new URL(src)
    let pathname = decodeURIComponent(parsed.pathname)
    if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
    return pathname.replace(/\//g, '\\')
  } catch {
    return null
  }
}

async function fetchGlbBytes(src: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const urls = [src]
  const localPath = fileUrlToServePath(src)
  const origin = cherryBackendOrigin()
  if (localPath) {
    const query = `path=${encodeURIComponent(localPath)}`
    urls.push(origin ? `${origin}/api/v1/files/serve?${query}` : `/api/v1/files/serve?${query}`)
  } else if (src.startsWith('/api/v1/files/serve') && origin) {
    urls.unshift(`${origin}${src}`)
  }
  let lastError = '无法下载 GLB'
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) {
        lastError = `下载失败 HTTP ${response.status}`
        continue
      }
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength < 16) {
        lastError = '文件为空'
        continue
      }
      return bytes
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error instanceof Error ? error.message : '无法下载 GLB'
    }
  }
  throw new Error(lastError)
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (!material) return
    const materials = Array.isArray(material) ? material : [material]
    for (const item of materials) {
      for (const value of Object.values(item)) {
        if (value && typeof value === 'object' && 'dispose' in value && typeof value.dispose === 'function') {
          value.dispose()
        }
      }
      item.dispose()
    }
  })
}

function parseGltf(bytes: ArrayBuffer): Promise<{ scene: THREE.Group }> {
  const dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath(dracoDecoderDirectory())
  dracoLoader.decoderConfig = { type: 'js' }
  const loader = new GLTFLoader()
  loader.setDRACOLoader(dracoLoader)
  return new Promise((resolve, reject) => {
    loader.parse(
      bytes,
      '',
      (gltf) => {
        dracoLoader.dispose()
        resolve({ scene: gltf.scene })
      },
      (err) => {
        dracoLoader.dispose()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

function frameModel(model: THREE.Object3D, camera: THREE.PerspectiveCamera): void {
  const box = new THREE.Box3().setFromObject(model)
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
  const scale = maxDim > 0 ? 2 / maxDim : 1
  model.scale.setScalar(scale)
  model.position.sub(center.multiplyScalar(scale))
  const framed = Math.max(maxDim * scale * 1.6, 1.4)
  camera.position.set(framed * 0.7, framed * 0.45, framed)
  camera.lookAt(0, 0, 0)
}

async function renderStill(src: string): Promise<string> {
  const bytes = await fetchGlbBytes(src, new AbortController().signal)
  const { scene: model } = await parseGltf(bytes)

  const canvas = document.createElement('canvas')
  canvas.width = STILL_SIZE
  canvas.height = STILL_SIZE
  canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:256px;height:256px;opacity:0;pointer-events:none'
  document.body.appendChild(canvas)

  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false
    })
  } catch {
    canvas.remove()
    disposeObject3D(model)
    throw new Error('WebGL not available')
  }

  renderer.setSize(STILL_SIZE, STILL_SIZE, false)
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.65

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x3a3a42)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4a55, 2.2))
  const keyLight = new THREE.DirectionalLight(0xfff6ea, 3.4)
  keyLight.position.set(4, 8, 6)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0xc8d8ff, 1.6)
  fillLight.position.set(-6, 3, -2)
  scene.add(fillLight)
  const rimLight = new THREE.DirectionalLight(0xffffff, 1.2)
  rimLight.position.set(0, 4, -6)
  scene.add(rimLight)

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
  const pmrem = new THREE.PMREMGenerator(renderer)
  let envTexture: THREE.Texture | undefined
  try {
    const room = new RoomEnvironment()
    envTexture = pmrem.fromScene(room, 0.04).texture
    scene.environment = envTexture
    scene.environmentIntensity = 1.15
    room.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
  } catch {
    scene.add(new THREE.AmbientLight(0xffffff, 1.4))
  }

  frameModel(model, camera)
  scene.add(model)
  renderer.render(scene, camera)
  renderer.render(scene, camera)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.84)

  envTexture?.dispose()
  pmrem.dispose()
  disposeObject3D(scene)
  scene.clear()
  try {
    renderer.forceContextLoss()
  } catch {
    /* Qt may have already dropped the context */
  }
  renderer.dispose()
  canvas.remove()
  return dataUrl
}

export function captureModelStill(src: string): Promise<string> {
  const hit = cache.get(src)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(src)
  if (pending) return pending

  const job = new Promise<string>((resolve, reject) => {
    queue = queue
      .then(() => renderStill(src))
      .then((url) => {
        cache.set(src, url)
        resolve(url)
      })
      .catch(reject)
      .then(() => undefined)
  })
  inflight.set(src, job)
  void job.finally(() => inflight.delete(src))
  return job
}
