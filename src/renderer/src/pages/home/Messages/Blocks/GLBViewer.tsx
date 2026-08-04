import React, { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import * as THREE from 'three'
// @ts-ignore - three subpath import; resolved correctly by bundler at runtime
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
// @ts-ignore
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'

interface Props {
  src: string
  width?: number
  height?: number
  onError?: (msg: string) => void
  onLoad?: () => void
  children?: React.ReactNode
}

const DEFAULT_W = 480
const DEFAULT_H = 340

const GLBViewer: React.FC<Props> = ({ src, width, height, onError, onLoad, children }) => {
  const mountRef = useRef<HTMLDivElement>(null)
  const [webglFailed, setWebglFailed] = useState(false)

  const w = width ?? DEFAULT_W
  const h = height ?? DEFAULT_H

  useEffect(() => {
    if (!src || !mountRef.current) return

    const container = mountRef.current

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)

    // Camera
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000)
    camera.position.set(0, 1, 3)

    // Renderer
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch {
      console.error('[GLBViewer] WebGL context creation failed')
      setWebglFailed(true)
      onError?.('WebGL not available in this environment')
      return
    }

    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambient)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(5, 10, 5)
    dirLight.castShadow = true
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4)
    fillLight.position.set(-5, 0, -5)
    scene.add(fillLight)

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.screenSpacePanning = false
    controls.minDistance = 0.1
    controls.maxDistance = 100

    // Animation mixer
    let mixer: THREE.AnimationMixer | null = null
    let animationId: number

    // Clock
    const clock = new THREE.Clock()

    // Animation loop
    const animate = () => {
      animationId = requestAnimationFrame(animate)
      const delta = clock.getDelta()
      mixer?.update(delta)
      controls.update()
      renderer.render(scene, camera)
    }

    // GLTF Loader
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')

    const loader = new GLTFLoader()
    loader.setDRACOLoader(dracoLoader)
    loader.load(
      src,
      (gltf) => {
        const model = gltf.scene

        // Auto-fit model to view
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z)
        const scale = maxDim > 0 ? 2 / maxDim : 1
        model.scale.setScalar(scale)
        model.position.sub(center.multiplyScalar(scale))

        scene.add(model)

        // Position camera based on model size
        camera.position.set(0, size.y * scale * 0.5, maxDim * scale * 1.8)
        camera.lookAt(0, 0, 0)
        controls.target.set(0, 0, 0)
        controls.update()

        // Animations
        if (gltf.animations && gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model)
          gltf.animations.forEach((clip) => {
            mixer!.clipAction(clip).play()
          })
        }

        animate()
        onLoad?.()
      },
      undefined,
      (err) => {
        console.error('[GLBViewer] Failed to load model:', err)
        onError?.('Failed to load model')
      }
    )

    return () => {
      cancelAnimationFrame(animationId)
      controls.dispose()
      mixer?.stopAllAction()
      dracoLoader.dispose()
      renderer.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [src, w, h])

  if (webglFailed) {
    return (
      <FallbackBox style={{ width: w, height: h }}>
        <span style={{ fontSize: 32 }}>🧊</span>
        <span>3D preview unavailable (WebGL not supported)</span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
          The model file is saved and can be downloaded
        </span>
        {children}
      </FallbackBox>
    )
  }

  return (
    <Wrapper style={{ width: w, height: h }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      {children}
    </Wrapper>
  )
}

const Wrapper = styled.div`
  position: relative;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  border-radius: 8px 8px 0 0;
  overflow: hidden;

  canvas {
    display: block;
    width: 100% !important;
    height: 100% !important;
  }
`

const FallbackBox = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  border-radius: 8px 8px 0 0;
  color: rgba(255, 255, 255, 0.6);
  font-size: 13px;
`

export default GLBViewer
