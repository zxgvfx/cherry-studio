import { useEffect, useRef } from 'react'
import * as THREE from 'three'
// @ts-ignore - three subpath import; resolved correctly by bundler at runtime
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
// @ts-ignore
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader'

interface FBXAnimationViewerProps {
  urls: string[]
  onLoad?: () => void
  onError?: (message: string) => void
}

export default function FBXAnimationViewer({ urls, onLoad, onError }: FBXAnimationViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const container = containerRef.current
    if (!urls.length || !container) return

    let disposed = false

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.01,
      10000
    )
    camera.position.set(0, 100, 300)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      console.error('[FBXAnimationViewer] WebGL context creation failed')
      onErrorRef.current?.('WebGL not available in this environment')
      return
    }

    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    container.appendChild(renderer.domElement)

    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambient)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(100, 200, 100)
    dirLight.castShadow = true
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4)
    fillLight.position.set(-100, 0, -100)
    scene.add(fillLight)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.screenSpacePanning = false

    const mixers: THREE.AnimationMixer[] = []
    const timer = new THREE.Timer()
    timer.connect(document)
    let animationId = 0

    const animate = () => {
      if (disposed) return
      animationId = requestAnimationFrame(animate)
      timer.update()
      const delta = timer.getDelta()
      mixers.forEach((m) => m.update(delta))
      controls.update()
      renderer.render(scene, camera)
    }

    const loader = new FBXLoader()
    let loadedCount = 0
    let hasLoadError = false

    urls.forEach((url, idx) => {
      loader.load(
        url,
        (fbx: THREE.Group) => {
          if (disposed) return

          const box = new THREE.Box3().setFromObject(fbx)
          const size = box.getSize(new THREE.Vector3())
          const center = box.getCenter(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)
          if (maxDim > 0) {
            const scale = 200 / maxDim
            fbx.scale.setScalar(scale)
            fbx.position.sub(center.multiplyScalar(scale))
          }

          fbx.position.x += idx * 250
          scene.add(fbx)

          const fbxAnimations = (fbx as unknown as { animations?: THREE.AnimationClip[] }).animations
          if (fbxAnimations && fbxAnimations.length > 0) {
            const mixer = new THREE.AnimationMixer(fbx)
            fbxAnimations.forEach((clip) => mixer.clipAction(clip).play())
            mixers.push(mixer)
          }

          loadedCount++
          if (loadedCount === urls.length) {
            const allBox = new THREE.Box3()
            scene.traverse((obj) => {
              if ((obj as THREE.Mesh).isMesh) {
                allBox.expandByObject(obj)
              }
            })
            const allCenter = allBox.getCenter(new THREE.Vector3())
            const allSize = allBox.getSize(new THREE.Vector3())
            const maxAllDim = Math.max(allSize.x, allSize.y, allSize.z)
            camera.position.set(allCenter.x, allCenter.y + maxAllDim * 0.5, allCenter.z + maxAllDim * 1.5)
            camera.lookAt(allCenter)
            controls.target.copy(allCenter)
            controls.update()
            animate()
            if (!hasLoadError) onLoadRef.current?.()
          }
        },
        undefined,
        (err: unknown) => {
          console.error('[FBXAnimationViewer] Failed to load:', url, err)
          hasLoadError = true
          loadedCount++
          if (loadedCount === urls.length) {
            animate()
            onErrorRef.current?.('Failed to load model')
          }
        }
      )
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
      resizeObserver.disconnect()
      cancelAnimationFrame(animationId)
      timer.dispose()
      controls.dispose()
      mixers.forEach((m) => m.stopAllAction())
      renderer.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [urls])

  return (
    <div
      ref={containerRef}
      className="[&>canvas]:!h-full [&>canvas]:!w-full relative h-full w-full overflow-hidden bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-[#0f3460] [&>canvas]:block"
    />
  )
}
