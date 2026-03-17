import { Loading3QuartersOutlined } from '@ant-design/icons'
import { Spin } from 'antd'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import styled from 'styled-components'

import type { ClickPoint, MaskLayer, SAM3CanvasHandle } from './SAM3Canvas'
import SAM3Canvas, { getLayerColor } from './SAM3Canvas'
import SAM3Sidebar from './SAM3Sidebar'
import { generate3D, predict, saveMasks, serveImage, setImage } from './sam3Service'

interface Props {
  imagePath: string
  onComplete?: (files: Array<{ id: string; name: string; path: string; ext: string; size: number }>) => void
  onCancel?: () => void
}

const SAM3Annotator: React.FC<Props> = ({ imagePath, onComplete }) => {
  const canvasRef = useRef<SAM3CanvasHandle>(null)

  const [imageDataUrl, setImageDataUrl] = useState<string>()
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 })
  const [layers, setLayers] = useState<MaskLayer[]>([])
  const [activeLayerId, setActiveLayerId] = useState<string>()
  const [clickMode, setClickMode] = useState(1)
  const [loading, setLoading] = useState(true)
  const [statusText, setStatusText] = useState('SYS >> INITIALIZING...')
  const [sessionId, setSessionId] = useState<string>()
  const layerCounter = useRef(0)

  useEffect(() => {
    const init = async () => {
      setStatusText('SYS >> LOADING IMAGE...')
      try {
        const imgResult = await serveImage(imagePath)
        if (imgResult.error || !imgResult.data_url) {
          setStatusText(`SYS >> ERROR: ${imgResult.error || 'Failed to load image'}`)
          return
        }
        setImageDataUrl(imgResult.data_url)
        setImageSize({ w: imgResult.width || 0, h: imgResult.height || 0 })

        setStatusText('SYS >> COMPUTING EMBEDDINGS...')
        const setResult = await setImage(imagePath)
        if (setResult.error) {
          setStatusText(`SYS >> ERROR: ${setResult.error}`)
          return
        }
        setSessionId(setResult.session_id)
        setStatusText('SYS >> READY TO SEGMENT.')
        setLoading(false)
      } catch (e: any) {
        setStatusText(`SYS >> ERROR: ${e.message}`)
      }
    }
    init()
  }, [imagePath])

  const createLayer = useCallback(() => {
    layerCounter.current += 1
    const id = String(layerCounter.current)
    const newLayer: MaskLayer = {
      id,
      name: `object_${layerCounter.current}`,
      color: getLayerColor(layers.length),
      points: [],
      visible: true
    }
    setLayers((prev) => [...prev, newLayer])
    setActiveLayerId(id)
    return id
  }, [layers.length])

  const handleCanvasClick = useCallback(
    async (imgX: number, imgY: number) => {
      if (loading) return

      let currentActiveId = activeLayerId
      if (!currentActiveId) {
        currentActiveId = createLayer()
      }

      const point: ClickPoint = { x: imgX, y: imgY, label: clickMode }

      setLayers((prev) => {
        const next = prev.map((l) => {
          if (l.id !== currentActiveId) return l
          return { ...l, points: [...l.points, point] }
        })
        runPredict(next.find((l) => l.id === currentActiveId)!)
        return next
      })
    },
    [activeLayerId, clickMode, loading, createLayer]
  )

  const handleCanvasRightClick = useCallback(
    (imgX: number, imgY: number) => {
      if (!activeLayerId) return
      setLayers((prev) => {
        const layer = prev.find((l) => l.id === activeLayerId)
        if (!layer || layer.points.length === 0) return prev

        const threshold = 15
        let closestIdx = -1
        let minDist = Infinity
        for (let i = 0; i < layer.points.length; i++) {
          const dx = layer.points[i].x - imgX
          const dy = layer.points[i].y - imgY
          const dist = dx * dx + dy * dy
          if (dist < minDist) {
            minDist = dist
            closestIdx = i
          }
        }
        if (closestIdx === -1 || minDist > threshold * threshold) return prev

        const newPoints = [...layer.points]
        newPoints.splice(closestIdx, 1)
        const updated = prev.map((l) => (l.id === activeLayerId ? { ...l, points: newPoints } : l))
        const updatedLayer = updated.find((l) => l.id === activeLayerId)!
        if (updatedLayer.points.length > 0) {
          runPredict(updatedLayer)
        } else {
          setLayers((p) => p.map((l) => (l.id === activeLayerId ? { ...l, maskDataUrl: undefined } : l)))
        }
        return updated
      })
    },
    [activeLayerId]
  )

  const runPredict = async (layer: MaskLayer) => {
    if (layer.points.length === 0) return
    setStatusText('SYS >> UPDATING MASK...')

    const points = layer.points.map((p) => [p.x, p.y])
    const labels = layer.points.map((p) => p.label)

    try {
      const result = await predict(points, labels)
      if (result.error) {
        setStatusText(`SYS >> PREDICT ERROR: ${result.error}`)
        return
      }

      if (result.mask_b64) {
        const maskImg = new Image()
        const rawDataUrl = `data:image/png;base64,${result.mask_b64}`

        maskImg.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = maskImg.width
          canvas.height = maskImg.height
          const ctx = canvas.getContext('2d')!

          ctx.drawImage(maskImg, 0, 0)
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const data = imgData.data

          const hexToRgb = (hex: string) => {
            const r = parseInt(hex.slice(1, 3), 16)
            const g = parseInt(hex.slice(3, 5), 16)
            const b = parseInt(hex.slice(5, 7), 16)
            return { r, g, b }
          }

          const { r, g, b } = hexToRgb(layer.color)
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 127) {
              data[i] = r
              data[i + 1] = g
              data[i + 2] = b
              data[i + 3] = 160
            } else {
              data[i + 3] = 0
            }
          }
          ctx.putImageData(imgData, 0, 0)
          const coloredUrl = canvas.toDataURL('image/png')

          setLayers((prev) =>
            prev.map((l) =>
              l.id === layer.id ? { ...l, maskDataUrl: coloredUrl, _rawMaskB64: result.mask_b64 } : l
            )
          )
          setStatusText(`SYS >> MASK UPDATED. IoU=${(result.iou || 0).toFixed(3)}`)
        }
        maskImg.src = rawDataUrl
      }
    } catch (e: any) {
      setStatusText(`SYS >> ERROR: ${e.message}`)
    }
  }

  const handleGenerate3D = useCallback(async () => {
    const visibleWithMask = layers.filter((l) => l.visible && (l as any)._rawMaskB64)
    if (visibleWithMask.length === 0) return

    setLoading(true)
    setStatusText('SYS >> SAVING MASKS...')

    try {
      const masksToSave = visibleWithMask.map((l) => ({
        name: l.name,
        mask_b64: (l as any)._rawMaskB64 as string
      }))
      const saveResult = await saveMasks(masksToSave, sessionId)
      if (saveResult.error || !saveResult.masks) {
        setStatusText(`SYS >> ERROR: ${saveResult.error}`)
        setLoading(false)
        return
      }

      setStatusText(`SYS >> GENERATING 3D (${saveResult.masks.length} objects)...`)
      const results: Array<{ id: string; name: string; path: string; ext: string; size: number }> = []

      for (let i = 0; i < saveResult.masks.length; i++) {
        const mask = saveResult.masks[i]
        setStatusText(`SYS >> [${i + 1}/${saveResult.masks.length}] Generating ${mask.name}...`)
        const gen = await generate3D(imagePath, mask.path, 'glb')
        if (gen.error) {
          setStatusText(`SYS >> ERROR: ${gen.error}`)
          setLoading(false)
          return
        }
        if (gen.file) {
          results.push(gen.file as any)
        }
      }

      setStatusText('SYS >> GENERATION COMPLETE.')
      setLoading(false)
      onComplete?.(results)
    } catch (e: any) {
      setStatusText(`SYS >> ERROR: ${e.message}`)
      setLoading(false)
    }
  }, [layers, sessionId, imagePath, onComplete])

  const handleExportMasks = useCallback(async () => {
    const withMask = layers.filter((l) => (l as any)._rawMaskB64)
    if (withMask.length === 0) return

    setStatusText('SYS >> EXPORTING MASKS...')
    const masksToSave = withMask.map((l) => ({
      name: l.name,
      mask_b64: (l as any)._rawMaskB64 as string
    }))

    try {
      const result = await saveMasks(masksToSave, sessionId)
      if (result.error) {
        setStatusText(`SYS >> ERROR: ${result.error}`)
      } else {
        setStatusText(`SYS >> EXPORTED ${result.masks?.length || 0} MASKS.`)
      }
    } catch (e: any) {
      setStatusText(`SYS >> ERROR: ${e.message}`)
    }
  }, [layers, sessionId])

  const handleClearPoints = useCallback(() => {
    if (!activeLayerId) return
    setLayers((prev) =>
      prev.map((l) => (l.id === activeLayerId ? { ...l, points: [], maskDataUrl: undefined } : l))
    )
  }, [activeLayerId])

  const handleClearAll = useCallback(() => {
    setLayers([])
    setActiveLayerId(undefined)
  }, [])

  const handleDeleteLayer = useCallback(
    (id: string) => {
      setLayers((prev) => prev.filter((l) => l.id !== id))
      if (activeLayerId === id) {
        setActiveLayerId(undefined)
      }
    },
    [activeLayerId]
  )

  const handleRenameLayer = useCallback((id: string, name: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, name } : l)))
  }, [])

  const handleToggleLayer = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)))
  }, [])

  if (!imageDataUrl && loading) {
    return (
      <LoadingContainer>
        <Spin indicator={<Loading3QuartersOutlined spin style={{ fontSize: 24, color: '#00ffb4' }} />} />
        <LoadingText>{statusText}</LoadingText>
      </LoadingContainer>
    )
  }

  return (
    <AnnotatorContainer>
      <SAM3Canvas
        ref={canvasRef}
        imageDataUrl={imageDataUrl}
        imageWidth={imageSize.w}
        imageHeight={imageSize.h}
        layers={layers}
        clickMode={clickMode}
        onCanvasClick={handleCanvasClick}
        onCanvasRightClick={handleCanvasRightClick}
      />
      <SAM3Sidebar
        layers={layers}
        activeLayerId={activeLayerId}
        clickMode={clickMode}
        loading={loading}
        statusText={statusText}
        onSetMode={setClickMode}
        onAddLayer={createLayer}
        onSelectLayer={setActiveLayerId}
        onToggleLayer={handleToggleLayer}
        onDeleteLayer={handleDeleteLayer}
        onRenameLayer={handleRenameLayer}
        onClearPoints={handleClearPoints}
        onClearAll={handleClearAll}
        onGenerate3D={handleGenerate3D}
        onExportMasks={handleExportMasks}
      />
    </AnnotatorContainer>
  )
}

const AnnotatorContainer = styled.div`
  display: flex;
  width: 100%;
  height: 100%;
  background: #0a0a0c;
  border-radius: 8px;
  overflow: hidden;
`

const LoadingContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  width: 100%;
  height: 400px;
  background: #0a0a0c;
  border-radius: 8px;
`

const LoadingText = styled.div`
  color: #00ffb4;
  font-family: 'Consolas', monospace;
  font-size: 12px;
`

export default React.memo(SAM3Annotator)
