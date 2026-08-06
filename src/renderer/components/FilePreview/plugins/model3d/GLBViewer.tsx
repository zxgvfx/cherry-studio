import { useEffect, useRef } from 'react'
import * as THREE from 'three'
// @ts-ignore - three subpath import; resolved correctly by bundler at runtime
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
// @ts-ignore
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'

interface GLBViewerProps {
  src: string
  onLoad?: () => void
  onError?: (message: string) => void
}

const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/'

export default function GLBViewer({ src, onLoad, onError }: GLBViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Stored in refs (not effect deps) so identity changes on every parent render
  // don't tear down and recreate the whole WebGL scene — only `src` should do that.
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const container = containerRef.current
    if (!src || !container) return

    let disposed = false

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.01,
      1000
    )
    camera.position.set(0, 1, 3)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch {
      console.error('[GLBViewer] WebGL context creation failed')
      onErrorRef.current?.('WebGL not available in this environment')
      return
    }

    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)

    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambient)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(5, 10, 5)
    dirLight.castShadow = true
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4)
    fillLight.position.set(-5, 0, -5)
    scene.add(fillLight)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.screenSpacePanning = false
    controls.minDistance = 0.1
    controls.maxDistance = 100

    let mixer: THREE.AnimationMixer | null = null
    let animationId = 0
    const clock = new THREE.Clock()

    const animate = () => {
      if (disposed) return
      animationId = requestAnimationFrame(animate)
      const delta = clock.getDelta()
      mixer?.update(delta)
      controls.update()
      renderer.render(scene, camera)
    }

    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath(DRACO_DECODER_PATH)

    const loader = new GLTFLoader()
    loader.setDRACOLoader(dracoLoader)
    loader.load(
      src,
      (gltf) => {
        if (disposed) return
        const model = gltf.scene

        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z)
        const scale = maxDim > 0 ? 2 / maxDim : 1
        model.scale.setScalar(scale)
        model.position.sub(center.multiplyScalar(scale))

        scene.add(model)

        camera.position.set(0, size.y * scale * 0.5, maxDim * scale * 1.8)
        camera.lookAt(0, 0, 0)
        controls.target.set(0, 0, 0)
        controls.update()

        if (gltf.animations && gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model)
          gltf.animations.forEach((clip: THREE.AnimationClip) => {
            mixer!.clipAction(clip).play()
          })
        }

        animate()
        onLoadRef.current?.()
      },
      undefined,
      (err: unknown) => {
        console.error('[GLBViewer] Failed to load model:', err)
        onErrorRef.current?.('Failed to load model')
      }
    )

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
      controls.dispose()
      mixer?.stopAllAction()
      dracoLoader.dispose()
      renderer.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [src])

  return (
    <div
      ref={containerRef}
      className="[&>canvas]:!h-full [&>canvas]:!w-full relative h-full w-full overflow-hidden bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-[#0f3460] [&>canvas]:block"
    />
  )
}
