import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import styled from 'styled-components'

export interface ClickPoint {
  x: number
  y: number
  label: number // 1 = foreground, 0 = background
}

export interface MaskLayer {
  id: string
  name: string
  color: string
  points: ClickPoint[]
  maskDataUrl?: string
  visible: boolean
}

export interface SAM3CanvasHandle {
  fitToView: () => void
}

interface Props {
  imageDataUrl?: string
  imageWidth: number
  imageHeight: number
  layers: MaskLayer[]
  clickMode: number
  onCanvasClick: (imgX: number, imgY: number) => void
  onCanvasRightClick: (imgX: number, imgY: number) => void
}

const LAYER_COLORS_HEX = ['#ff0080', '#00ffb4', '#ffc800', '#6464ff', '#00ff00']

export function getLayerColor(index: number): string {
  return LAYER_COLORS_HEX[index % LAYER_COLORS_HEX.length]
}

const SAM3Canvas = React.forwardRef<SAM3CanvasHandle, Props>(
  ({ imageDataUrl, imageWidth, imageHeight, layers, clickMode, onCanvasClick, onCanvasRightClick }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [scale, setScale] = useState(1)
    const [offset, setOffset] = useState({ x: 0, y: 0 })
    const [panning, setPanning] = useState(false)
    const lastMouseRef = useRef({ x: 0, y: 0 })
    const imageRef = useRef<HTMLImageElement | null>(null)
    const maskImagesRef = useRef<Map<string, HTMLImageElement>>(new Map())

    const fitToView = useCallback(() => {
      if (!containerRef.current || !imageWidth || !imageHeight) return
      const cw = containerRef.current.clientWidth - 40
      const ch = containerRef.current.clientHeight - 40
      const s = Math.min(cw / imageWidth, ch / imageHeight, 1)
      setScale(s)
      setOffset({
        x: (containerRef.current.clientWidth - imageWidth * s) / 2,
        y: (containerRef.current.clientHeight - imageHeight * s) / 2
      })
    }, [imageWidth, imageHeight])

    useImperativeHandle(ref, () => ({ fitToView }), [fitToView])

    useEffect(() => {
      if (!imageDataUrl) return
      const img = new Image()
      img.onload = () => {
        imageRef.current = img
        fitToView()
      }
      img.src = imageDataUrl
    }, [imageDataUrl, fitToView])

    useEffect(() => {
      for (const layer of layers) {
        if (layer.maskDataUrl) {
          if (!maskImagesRef.current.has(layer.id) || maskImagesRef.current.get(layer.id)!.src !== layer.maskDataUrl) {
            const img = new Image()
            img.onload = () => {
              maskImagesRef.current.set(layer.id, img)
              draw()
            }
            img.src = layer.maskDataUrl
          }
        } else {
          maskImagesRef.current.delete(layer.id)
        }
      }
      draw()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layers, scale, offset])

    const draw = useCallback(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      canvas.width = cw * dpr
      canvas.height = ch * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      ctx.fillStyle = '#0a0a0c'
      ctx.fillRect(0, 0, cw, ch)

      drawGrid(ctx, cw, ch)

      if (!imageRef.current) {
        ctx.fillStyle = '#3c3c3c'
        ctx.font = '14px Consolas, monospace'
        ctx.textAlign = 'center'
        ctx.fillText('[ WAITING FOR SOURCE ]', cw / 2, ch / 2)
        return
      }

      ctx.drawImage(imageRef.current, offset.x, offset.y, imageWidth * scale, imageHeight * scale)

      for (const layer of layers) {
        if (!layer.visible) continue

        const maskImg = maskImagesRef.current.get(layer.id)
        if (maskImg) {
          ctx.save()
          ctx.globalAlpha = 0.5
          ctx.drawImage(maskImg, offset.x, offset.y, imageWidth * scale, imageHeight * scale)
          ctx.restore()
        }

        for (const pt of layer.points) {
          const sx = pt.x * scale + offset.x
          const sy = pt.y * scale + offset.y

          if (pt.label === 1) {
            ctx.beginPath()
            ctx.arc(sx, sy, 5, 0, Math.PI * 2)
            ctx.fillStyle = layer.color
            ctx.fill()

            const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 12)
            grad.addColorStop(0, layer.color + '80')
            grad.addColorStop(1, 'transparent')
            ctx.beginPath()
            ctx.arc(sx, sy, 12, 0, Math.PI * 2)
            ctx.fillStyle = grad
            ctx.fill()
          } else {
            ctx.strokeStyle = '#ff4444'
            ctx.lineWidth = 2
            const hs = 5
            ctx.beginPath()
            ctx.moveTo(sx - hs, sy - hs)
            ctx.lineTo(sx + hs, sy + hs)
            ctx.moveTo(sx - hs, sy + hs)
            ctx.lineTo(sx + hs, sy - hs)
            ctx.stroke()
          }
        }
      }

      drawHUD(ctx, cw)
    }, [scale, offset, layers, imageWidth, imageHeight])

    const drawGrid = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'
      ctx.lineWidth = 1
      const gap = 50
      for (let x = 0; x < w; x += gap) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      for (let y = 0; y < h; y += gap) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
    }

    const drawHUD = (ctx: CanvasRenderingContext2D, w: number) => {
      ctx.fillStyle = 'rgba(120,130,150,0.6)'
      ctx.font = '10px Consolas, monospace'
      ctx.textAlign = 'right'
      ctx.fillText(`ZOOM: ${(scale * 100).toFixed(0)}%`, w - 10, 20)
    }

    const screenToImage = (clientX: number, clientY: number) => {
      const rect = canvasRef.current!.getBoundingClientRect()
      const sx = clientX - rect.left
      const sy = clientY - rect.top
      return {
        x: (sx - offset.x) / scale,
        y: (sy - offset.y) / scale
      }
    }

    const handleMouseDown = (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        setPanning(true)
        lastMouseRef.current = { x: e.clientX, y: e.clientY }
        e.preventDefault()
      } else if (e.button === 0 && imageRef.current) {
        const { x, y } = screenToImage(e.clientX, e.clientY)
        if (x >= 0 && y >= 0 && x < imageWidth && y < imageHeight) {
          onCanvasClick(x, y)
        }
      }
    }

    const handleMouseMove = (e: React.MouseEvent) => {
      if (panning) {
        const dx = e.clientX - lastMouseRef.current.x
        const dy = e.clientY - lastMouseRef.current.y
        setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
        lastMouseRef.current = { x: e.clientX, y: e.clientY }
      }
    }

    const handleMouseUp = () => {
      setPanning(false)
    }

    const handleWheel = (e: React.WheelEvent) => {
      e.preventDefault()
      const rect = canvasRef.current!.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      const factor = e.deltaY < 0 ? 1.15 : 0.85
      const newScale = Math.max(0.05, Math.min(scale * factor, 50))
      const ratio = newScale / scale

      setOffset((prev) => ({
        x: mx - (mx - prev.x) * ratio,
        y: my - (my - prev.y) * ratio
      }))
      setScale(newScale)
    }

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault()
      if (!imageRef.current) return
      const { x, y } = screenToImage(e.clientX, e.clientY)
      if (x >= 0 && y >= 0 && x < imageWidth && y < imageHeight) {
        onCanvasRightClick(x, y)
      }
    }

    return (
      <Container ref={containerRef}>
        <StyledCanvas
          ref={canvasRef}
          $cursor={panning ? 'grabbing' : clickMode === 1 ? 'crosshair' : 'not-allowed'}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={handleContextMenu}
        />
      </Container>
    )
  }
)

SAM3Canvas.displayName = 'SAM3Canvas'

const Container = styled.div`
  flex: 1;
  position: relative;
  overflow: hidden;
  background: #0a0a0c;
`

const StyledCanvas = styled.canvas<{ $cursor: string }>`
  width: 100%;
  height: 100%;
  display: block;
  cursor: ${(p) => p.$cursor};
`

export default React.memo(SAM3Canvas)
