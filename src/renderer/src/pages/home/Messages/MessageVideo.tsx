import { DownloadOutlined, Loading3QuartersOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { loggerService } from '@renderer/services/LoggerService'
import { MessageBlockStatus, type VideoMessageBlock } from '@renderer/types/newMessage'
import { Tooltip } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactPlayer from 'react-player'
import styled, { keyframes } from 'styled-components'

const logger = loggerService.withContext('MessageVideo')
interface Props {
  block: VideoMessageBlock
}

const SERVE_PATH = '/api/v1/files/serve'
const PREVIEW_PATH = '/api/v1/files/preview-video'

// webview 可直接解码的容器；其它（H.264 mp4 等）改走后端转码预览端点
const DIRECT_PLAY_NAME_REGEX = /\.(webm|ogg|ogv)$/i

/**
 * 兼容存量数据：历史视频块里可能存了带旧端口的绝对 serve 地址
 * （如 http://127.0.0.1:旧端口/api/v1/files/serve?name=xxx）。后端端口每次
 * 启动可能变，这里统一把本地 serve 地址重写到当前 origin；远端直链原样返回。
 */
function normalizeVideoUrl(url?: string): string | undefined {
  if (!url) return url
  const idx = url.indexOf(SERVE_PATH)
  if (idx === -1) return url
  return `${window.location.origin}${url.slice(idx)}`
}

/**
 * 把 URL 转成"可播放"地址：
 * - blob: 重启后必然失效，直接丢弃
 * - 本地 serve 地址重写到当前 origin；name 不是 webm/ogg 时改走 preview-video
 *   端点（按需转码，修复保存时转码失败、重启后 mp4 在 QtWebEngine 放不了的存量数据）
 * - 远端直链原样返回
 */
function toPlayableUrl(url?: string): string | undefined {
  if (!url) return undefined
  if (url.startsWith('blob:')) return undefined

  const idx = url.indexOf(SERVE_PATH)
  if (idx === -1) return url

  let rewritten = `${window.location.origin}${url.slice(idx)}`
  const nameMatch = /[?&]name=([^&]+)/.exec(rewritten)
  const name = nameMatch ? decodeURIComponent(nameMatch[1]) : ''
  if (name && !DIRECT_PLAY_NAME_REGEX.test(name)) {
    rewritten = rewritten.replace(SERVE_PATH, PREVIEW_PATH)
  }
  return rewritten
}

const MessageVideo: FC<Props> = ({ block }) => {
  const playerRef = useRef<HTMLVideoElement | null>(null)
  const { t } = useTranslation()

  logger.debug(`MessageVideo: ${JSON.stringify(block)}`)

  // 播放源候选链：url -> download_url，全部失败则展示错误兜底
  const playableCandidates = useMemo(() => {
    const candidates = [toPlayableUrl(block.url), toPlayableUrl(block.metadata?.download_url as string)]
    return [...new Set(candidates.filter(Boolean))] as string[]
  }, [block.url, block.metadata?.download_url])

  const [sourceIndex, setSourceIndex] = useState(0)
  const playableUrl = playableCandidates[sourceIndex]

  // 候选源变化（如重新生成）时从头开始尝试
  useEffect(() => {
    setSourceIndex(0)
  }, [playableCandidates])

  const handlePlayError = useCallback(() => {
    logger.warn(`Video source failed to play: ${playableCandidates[sourceIndex]}`)
    setSourceIndex((i) => i + 1)
  }, [playableCandidates, sourceIndex])

  const isLoading =
    block.status === MessageBlockStatus.PROCESSING ||
    block.status === MessageBlockStatus.PENDING ||
    block.status === MessageBlockStatus.STREAMING

  // 下载用原始 mp4（兼容性更好、便于外部分享）；预览用的可能是转码后的 webm。
  const downloadUrl = useMemo(
    () => normalizeVideoUrl((block.metadata?.download_url as string) || block.url),
    [block.metadata?.download_url, block.url]
  )

  const handleDownload = useCallback(() => {
    const href = downloadUrl || playableUrl
    if (!href) return
    const a = document.createElement('a')
    a.href = href
    a.download = (block.metadata?.origin_name as string) || `video-${block.id}.mp4`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [downloadUrl, playableUrl, block.metadata?.origin_name, block.id])

  // 视频生成进行中：展示加载动画与进度文案
  if (isLoading) {
    const progressText = block.metadata?.progressText as string | undefined
    return (
      <Container>
        <LoadingWrapper>
          <SpinIcon />
          <LoadingText>{t('video.generating', 'Generating video...')}</LoadingText>
          {progressText && <ProgressText>{progressText}</ProgressText>}
        </LoadingWrapper>
      </Container>
    )
  }

  if (!block.url && !block.filePath) {
    return null
  }

  /**
   * 渲染本地视频文件（知识库检索 / 用户上传）
   */
  const renderLocalVideo = () => {
    if (!block.filePath) {
      logger.warn('Local video was requested but block.filePath is missing.')
      return <div>{t('message.video.error.local_file_missing')}</div>
    }

    const videoSrc = `file://${block.metadata?.video.path}`

    const handleReady = () => {
      const startTime = Math.floor(block.metadata?.startTime ?? 0)
      if (playerRef.current) {
        playerRef.current.currentTime = startTime
      }
    }

    return (
      <ReactPlayer
        ref={playerRef}
        style={{
          height: '100%',
          width: '100%'
        }}
        src={videoSrc}
        controls
        onReady={handleReady}
      />
    )
  }

  /**
   * 渲染生成的视频。用原生 <video> 而非 ReactPlayer：ReactPlayer 会按 URL 后缀
   * 识别来源类型，而我们的播放地址是 /api/v1/files/serve?name=xxx.mp4（带 query、
   * 不以 .mp4 结尾），会被识别失败导致不播放。原生 video 直接按 Content-Type 播放，
   * 并能正常发起 Range 请求。
   *
   * 播放失败（文件丢失 / 远端直链过期 / 解码失败）时自动切换到下一个候选源，
   * 全部失败则展示错误兜底（保留下载按钮，原始 mp4 可能仍可下载到本地播放）。
   */
  const renderGeneratedVideo = () => {
    if (!playableUrl) {
      return (
        <ErrorWrapper>
          <PlayCircleOutlined style={{ fontSize: 28, opacity: 0.5 }} />
          <ErrorText>{t('message.video.error.playback_failed')}</ErrorText>
          {downloadUrl && (
            <Tooltip title={t('video.download', 'Download video')}>
              <DownloadButton onClick={handleDownload}>
                <DownloadOutlined />
              </DownloadButton>
            </Tooltip>
          )}
        </ErrorWrapper>
      )
    }

    return (
      <PlayerWrapper>
        <video
          key={playableUrl}
          ref={playerRef}
          style={{ height: '100%', width: '100%', objectFit: 'contain', background: '#000' }}
          src={playableUrl}
          controls
          preload="metadata"
          onError={handlePlayError}
        />
        <Tooltip title={t('video.download', 'Download video')}>
          <DownloadButton onClick={handleDownload}>
            <DownloadOutlined />
          </DownloadButton>
        </Tooltip>
      </PlayerWrapper>
    )
  }

  const renderVideo = () => {
    switch (block.metadata?.type) {
      case 'video':
        return renderLocalVideo()

      default:
        // 生成的视频以 url 形式播放
        if (block.url) {
          return renderGeneratedVideo()
        }

        if (block.filePath) {
          logger.warn(
            `Unknown video type: ${block.metadata?.type}, but with filePath will try to render as local video.`
          )
          return renderLocalVideo()
        }

        logger.warn(`Unsupported video type: ${block.metadata?.type} or missing necessary data.`)
        return <div>{t('message.video.error.unsupported_type')}</div>
    }
  }

  return <Container>{renderVideo()}</Container>
}

export default MessageVideo

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`

const Container = styled.div`
  max-width: 560px;
  width: 100%;
  aspect-ratio: 16 / 9;
  height: auto;
  background-color: #000;
  border-radius: 8px;
  overflow: hidden;
`

const PlayerWrapper = styled.div`
  position: relative;
  width: 100%;
  height: 100%;
`

const DownloadButton = styled.button`
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  backdrop-filter: blur(8px);
  opacity: 0.7;
  transition: opacity 0.2s ease;

  &:hover {
    opacity: 1;
    background: rgba(0, 0, 0, 0.7);
  }
`

const LoadingWrapper = styled.div`
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
`

const SpinIcon = styled(Loading3QuartersOutlined)`
  font-size: 32px;
  color: var(--color-primary);
  animation: ${spin} 1s linear infinite;
`

const LoadingText = styled.span`
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
`

const ErrorWrapper = styled.div`
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.65);
`

const ErrorText = styled.span`
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  text-align: center;
  padding: 0 16px;
`

const ProgressText = styled.span`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  text-align: center;
  padding: 0 16px;
`
