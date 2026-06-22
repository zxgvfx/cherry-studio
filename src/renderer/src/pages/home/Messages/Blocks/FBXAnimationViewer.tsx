import React, { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import * as THREE from 'three'
// @ts-ignore - three subpath import; resolved correctly by bundler at runtime
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
// @ts-ignore
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader'

interface Props {
  urls: string[]
  width?: number
  height?: number
}

const DEFAULT_W = 480
const DEFAULT_H = 340

const FBXAnimationViewer: React.FC<Props> = ({ urls, width, height }) => {
  const mountRef = useRef<HTMLDivElement>(null)
  const [webglFailed, setWebglFailed] = useState(false)

  const w = width ?? DEFAULT_W
  const h = height ?? DEFAULT_H

  useEffect(() => {
    if (!urls.length || !mountRef.current) return

    const container = mountRef.current

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)

    // Camera
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 10000)
    camera.position.set(0, 100, 300)

    // Renderer
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      console.error('[FBXAnimationViewer] WebGL context creation failed')
      setWebglFailed(true)
      return
    }

    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    container.appendChild(renderer.domElement)

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambient)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(100, 200, 100)
    dirLight.castShadow = true
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4)
    fillLight.position.set(-100, 0, -100)
    scene.add(fillLight)

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.screenSpacePanning = false

    // Mixers & clock
    const mixers: THREE.AnimationMixer[] = []
    const clock = new THREE.Clock()
    let animationId: number

    const animate = () => {
      animationId = requestAnimationFrame(animate)
      const delta = clock.getDelta()
      mixers.forEach((m) => m.update(delta))
      controls.update()
      renderer.render(scene, camera)
    }

    // Load all FBX files
    const loader = new FBXLoader()
    let loadedCount = 0

    urls.forEach((url, idx) => {
      loader.load(
        url,
        (fbx) => {
          // Auto-scale to reasonable size
          const box = new THREE.Box3().setFromObject(fbx)
          const size = box.getSize(new THREE.Vector3())
          const center = box.getCenter(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)
          if (maxDim > 0) {
            const scale = 200 / maxDim
            fbx.scale.setScalar(scale)
            fbx.position.sub(center.multiplyScalar(scale))
          }

          // Offset multiple variants along X
          fbx.position.x += idx * 250

          scene.add(fbx)

          // Animations
          if (fbx.animations && fbx.animations.length > 0) {
            const mixer = new THREE.AnimationMixer(fbx)
            fbx.animations.forEach((clip) => mixer.clipAction(clip).play())
            mixers.push(mixer)
          }

          loadedCount++
          if (loadedCount === urls.length) {
            // Fit camera to all loaded models
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
          }
        },
        undefined,
        (err) => {
          console.error('[FBXAnimationViewer] Failed to load:', url, err)
          loadedCount++
          if (loadedCount === urls.length) animate()
        }
      )
    })

    return () => {
      cancelAnimationFrame(animationId)
      controls.dispose()
      mixers.forEach((m) => m.stopAllAction())
      renderer.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [urls, w, h])

  if (webglFailed) {
    return (
      <FallbackBox style={{ width: w, height: h }}>
        <span style={{ fontSize: 32 }}>🧊</span>
        <span>3D preview unavailable (WebGL not supported)</span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
          The model file is saved and can be downloaded
        </span>
      </FallbackBox>
    )
  }

  return (
    <Wrapper style={{ width: w, height: h }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
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

export default FBXAnimationViewer
