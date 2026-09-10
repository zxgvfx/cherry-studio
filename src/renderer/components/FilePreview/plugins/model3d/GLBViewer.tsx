import { loggerService } from '@logger'
import { RELEASE_INLINE_WEBGL_EVENT } from '@renderer/utils/qtWebEngineStability'
import { Layers3, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as THREE from 'three'
// @ts-ignore - three subpath import; resolved correctly by bundler at runtime
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
// @ts-ignore
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment'
// @ts-ignore
import dracoDecoderUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.js?url'
// @ts-ignore
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'

import { applyExplode, prepareExplodePieces } from './explodePieces'

const logger = loggerService.withContext('GLBViewer')

interface GLBViewerProps {
  src: string
  onLoad?: () => void
  onError?: (message: string) => void
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

function filesServeUrl(localPath: string): string {
  const origin = cherryBackendOrigin()
  const query = `path=${encodeURIComponent(localPath)}`
  return origin ? `${origin}/api/v1/files/serve?${query}` : `/api/v1/files/serve?${query}`
}

async function fetchGlbBytes(src: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const urls = [src]
  const localPath = fileUrlToServePath(src)
  if (localPath) {
    urls.push(filesServeUrl(localPath))
  } else if (src.startsWith('/api/v1/files/serve')) {
    const origin = cherryBackendOrigin()
    if (origin) urls.unshift(`${origin}${src}`)
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
    const material = (obj as THREE.Mesh).material
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

export default function GLBViewer({ src, onLoad, onError }: GLBViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [held, setHeld] = useState(true)
  const [explode, setExplode] = useState(0)
  const [canExplode, setCanExplode] = useState(false)
  const explodeRef = useRef(0)
  const applyExplodeRef = useRef<(amount: number) => void>(() => undefined)
  // Stored in refs (not effect deps) so identity changes on every parent render
  // don't tear down and recreate the whole WebGL scene — only `src` should do that.
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    setHeld(true)
    setExplode(0)
    explodeRef.current = 0
    setCanExplode(false)
    const onRelease = () => setHeld(false)
    window.addEventListener(RELEASE_INLINE_WEBGL_EVENT, onRelease)
    return () => window.removeEventListener(RELEASE_INLINE_WEBGL_EVENT, onRelease)
  }, [src])

  useEffect(() => {
    const container = containerRef.current
    if (!src || !container || !held) return

    let disposed = false

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x3a3a42)

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.01,
      1000
    )
    camera.position.set(0, 1, 3)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: 'low-power',
        failIfMajorPerformanceCaveat: false
      })
    } catch {
      logger.error('WebGL context creation failed')
      onErrorRef.current?.('WebGL not available in this environment')
      return
    }

    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setPixelRatio(1)
    renderer.shadowMap.enabled = false
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.65
    container.appendChild(renderer.domElement)
    renderer.domElement.draggable = false
    renderer.domElement.style.touchAction = 'none'
    renderer.domElement.style.cursor = 'grab'

    const onContextLost = (event: Event) => {
      event.preventDefault()
      if (disposed) return
      disposed = true
      onErrorRef.current?.('WebGL context lost')
    }
    const stopNativeDrag = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    const stopPointerBubble = (event: Event) => {
      event.stopPropagation()
    }
    const preventContextMenu = (event: Event) => {
      event.preventDefault()
    }
    const grabCursor = () => {
      renderer.domElement.style.cursor = 'grabbing'
    }
    const releaseCursor = () => {
      renderer.domElement.style.cursor = 'grab'
    }
    renderer.domElement.addEventListener('webglcontextlost', onContextLost, false)
    renderer.domElement.addEventListener('dragstart', stopNativeDrag)
    renderer.domElement.addEventListener('pointerdown', stopPointerBubble)
    renderer.domElement.addEventListener('pointerdown', grabCursor)
    renderer.domElement.addEventListener('pointerup', releaseCursor)
    renderer.domElement.addEventListener('pointerleave', releaseCursor)
    renderer.domElement.addEventListener('contextmenu', preventContextMenu)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x4a4a55, 2.2)
    scene.add(hemi)
    const keyLight = new THREE.DirectionalLight(0xfff6ea, 3.4)
    keyLight.position.set(4, 8, 6)
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xc8d8ff, 1.6)
    fillLight.position.set(-6, 3, -2)
    scene.add(fillLight)
    const rimLight = new THREE.DirectionalLight(0xffffff, 1.2)
    rimLight.position.set(0, 4, -6)
    scene.add(rimLight)

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
      const ambient = new THREE.AmbientLight(0xffffff, 1.4)
      scene.add(ambient)
    }

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.12
    controls.rotateSpeed = 0.95
    controls.zoomSpeed = 1.15
    controls.panSpeed = 0.9
    controls.screenSpacePanning = true
    controls.enablePan = true
    controls.enableZoom = true
    controls.enableRotate = true
    controls.minDistance = 0.15
    controls.maxDistance = 80
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    }

    let mixer: THREE.AnimationMixer | null = null
    let animationId = 0
    const timer = new THREE.Timer()
    timer.connect(document)
    const abort = new AbortController()

    const animate = () => {
      if (disposed) return
      animationId = requestAnimationFrame(animate)
      timer.update()
      mixer?.update(timer.getDelta())
      controls.update()
      renderer.render(scene, camera)
    }

    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath(dracoDecoderDirectory())
    // Prefer the JS decoder (Qt WebEngine / missing wasm assets). setDecoderConfig is removed in r194.
    dracoLoader.decoderConfig = { type: 'js' }

    const loader = new GLTFLoader()
    loader.setDRACOLoader(dracoLoader)
    animate()

    const onGltf = (gltf: { scene: THREE.Group; animations?: THREE.AnimationClip[] }) => {
      if (disposed) {
        disposeObject3D(gltf.scene)
        return
      }
      const model = gltf.scene

      const box = new THREE.Box3().setFromObject(model)
      const center = box.getCenter(new THREE.Vector3())
      const maxDim = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
      const scale = maxDim > 0 ? 2 / maxDim : 1
      model.scale.setScalar(scale)
      model.position.sub(center.multiplyScalar(scale))
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        const material = mesh.material
        if (!material) return
        const materials = Array.isArray(material) ? material : [material]
        for (const item of materials) {
          const std = item as THREE.MeshStandardMaterial
          if ('envMapIntensity' in std) std.envMapIntensity = 1.25
          item.needsUpdate = true
        }
      })

      scene.add(model)

      const pieces = prepareExplodePieces(model)
      applyExplodeRef.current = (amount: number) => applyExplode(pieces, amount)
      setCanExplode(pieces.length >= 2)
      applyExplode(pieces, explodeRef.current)

      const framed = Math.max(maxDim * scale * 1.6, 1.4)
      camera.position.set(framed * 0.7, framed * 0.45, framed)
      camera.lookAt(0, 0, 0)
      controls.target.set(0, 0, 0)
      controls.minDistance = Math.max(framed * 0.25, 0.2)
      controls.maxDistance = Math.max(framed * 8, 12)
      controls.update()

      if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model)
        gltf.animations.forEach((clip: THREE.AnimationClip) => {
          mixer!.clipAction(clip).play()
        })
      }

      onLoadRef.current?.()
    }

    void fetchGlbBytes(src, abort.signal)
      .then((bytes) => {
        if (disposed) return
        loader.parse(bytes, '', onGltf, (err: unknown) => {
          if (disposed) return
          logger.error('Failed to parse model', err instanceof Error ? err : new Error(String(err)))
          onErrorRef.current?.('GLB 解析失败')
        })
      })
      .catch((err: unknown) => {
        if (disposed || abort.signal.aborted) return
        logger.error('Failed to load model', err instanceof Error ? err : new Error(String(err)))
        onErrorRef.current?.(err instanceof Error ? err.message : 'GLB 加载失败')
      })

    const resizeObserver = new ResizeObserver(() => {
      if (disposed || !container.clientWidth || !container.clientHeight) return
      camera.aspect = container.clientWidth / container.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(container.clientWidth, container.clientHeight)
    })
    resizeObserver.observe(container)

    return () => {
      disposed = true
      applyExplodeRef.current = () => undefined
      abort.abort()
      resizeObserver.disconnect()
      cancelAnimationFrame(animationId)
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      renderer.domElement.removeEventListener('dragstart', stopNativeDrag)
      renderer.domElement.removeEventListener('pointerdown', stopPointerBubble)
      renderer.domElement.removeEventListener('pointerdown', grabCursor)
      renderer.domElement.removeEventListener('pointerup', releaseCursor)
      renderer.domElement.removeEventListener('pointerleave', releaseCursor)
      renderer.domElement.removeEventListener('contextmenu', preventContextMenu)
      controls.dispose()
      mixer?.stopAllAction()
      mixer = null
      timer.dispose()
      dracoLoader.dispose()
      envTexture?.dispose()
      pmrem.dispose()
      disposeObject3D(scene)
      scene.clear()
      try {
        renderer.forceContextLoss()
      } catch {
        // Qt WebEngine may already have dropped the context during navigation.
      }
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [held, src])

  useEffect(() => {
    explodeRef.current = explode
    applyExplodeRef.current(explode)
  }, [explode])

  const explodePercent = Math.round((explode / 2) * 100)

  return (
    <div className="relative h-full min-h-[240px] w-full overflow-hidden bg-[#3a3a42]">
      <div
        ref={containerRef}
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className="[&>canvas]:!h-full [&>canvas]:!w-full absolute inset-0 z-0 [&>canvas]:block"
      />
      <div
        data-testid="glb-explode-slider"
        className="-translate-x-1/2 absolute bottom-4 left-1/2 z-30 grid min-h-12 w-[min(410px,calc(100%-32px))] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-white/10 bg-[#16171c]/90 px-2.5 py-2 shadow-[0_12px_30px_rgba(0,0,0,0.28),inset_0_1px_rgba(255,255,255,0.04)] backdrop-blur-xl"
        onPointerDown={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-[#35c8a0]/[0.12] text-[#35c8a0]">
            <Layers3 aria-hidden size={15} strokeWidth={1.8} />
          </span>
          <span className="text-xs font-semibold text-white">{t('file_preview.explode')}</span>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <div className="relative flex min-w-0 flex-1 items-center">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 h-1 overflow-hidden rounded-full bg-white/15">
              <span className="block h-full rounded-full bg-[#35c8a0]" style={{ width: `${explodePercent}%` }} />
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={explode}
              disabled={!canExplode}
              aria-label={t('file_preview.explode_hint')}
              title={canExplode ? t('file_preview.explode_hint') : t('file_preview.explode_unavailable')}
              onChange={(event) => setExplode(Number(event.target.value))}
              className="relative h-5 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent accent-[#35c8a0] disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#16171c] [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
            />
          </div>
          <output className="w-8 text-right text-[11px] text-white/60 tabular-nums">{explodePercent}%</output>
        </div>

        <button
          type="button"
          aria-label={t('file_preview.explode_reset')}
          title={t('file_preview.explode_reset')}
          disabled={!canExplode || explode === 0}
          onClick={() => setExplode(0)}
          className="grid size-7 place-items-center rounded-lg border-0 bg-transparent text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-0">
          <RotateCcw aria-hidden size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
