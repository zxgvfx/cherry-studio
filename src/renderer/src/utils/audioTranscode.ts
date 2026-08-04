/**
 * 客户端音频转码工具
 *
 * 策略（按优先级）：
 *   1. 优先调用 main 进程的 ffmpeg 直接压缩为 mp3（64 kbps mono 16 kHz）。
 *      - 兼容性最好（覆盖 m4a / aac / opus / wma 等任何 ffmpeg 支持的格式）
 *      - 体积小（同等时长比 wav 小 ~10×），避开网关 `client_max_body_size` 413
 *   2. ffmpeg 不可用 → Web Audio API 解码后编码为 16-bit PCM WAV。
 *      - 仅用于备用，Chromium 通常无法解 AAC，会失败
 *
 * 返回 `{ base64, mime, ext }`，调用方据此决定 mediaType / filename 后缀。
 */
import { loggerService } from '@logger'

const logger = loggerService.withContext('audioTranscode')

export interface TranscodedAudio {
  base64: string
  mime: string
  ext: string
}

let sharedCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    const Ctor: typeof AudioContext =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!
    sharedCtx = new Ctor()
  }
  return sharedCtx
}

type FileApi = {
  transcodeAudio?: (id: string, format?: 'mp3' | 'wav') => Promise<{ base64: string; mime: string; ext: string }>
  transcodeAudioToWav?: (id: string) => Promise<{ base64: string }>
}

function getFileApi(): FileApi | undefined {
  return (window as unknown as { api?: { file?: FileApi } }).api?.file
}

/**
 * 把任意音频压缩转码为模型可消费、网关可放行的紧凑格式（默认 mp3）。
 *
 * @param base64 原始音频文件的 base64（不含 data URL 前缀）
 * @param fileId storage 内的文件名（含 ext，如 'uuid.m4a'），用于 ffmpeg 兜底
 * @param preferredFormat 优先格式，默认 'mp3'
 */
export async function transcodeAudioBase64(
  base64: string,
  fileId?: string,
  preferredFormat: 'mp3' | 'wav' = 'mp3'
): Promise<TranscodedAudio> {
  const fileApi = getFileApi()

  // 明确诊断：到底是哪一步卡住的
  if (!fileId) {
    logger.warn('transcodeAudioBase64: no fileId provided, skipping ffmpeg fallback')
  } else if (!fileApi?.transcodeAudio) {
    logger.warn(
      'transcodeAudioBase64: window.api.file.transcodeAudio is UNAVAILABLE. ' +
        '原因通常是 main 进程 / preload 还运行的是旧版本 —— 你只重载了窗口，没有完整退出 Electron。' +
        '请彻底退出 Cherry Studio（含系统托盘图标）后重新启动。'
    )
  } else {
    try {
      const result = await fileApi.transcodeAudio(fileId, preferredFormat)
      logger.info(`Audio transcoded via ffmpeg (main process) -> ${result.ext}`, {
        bytes: Math.floor((result.base64.length * 3) / 4)
      })
      return result
    } catch (ffmpegErr) {
      const msg = ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr)
      logger.warn(`ffmpeg transcode FAILED (main process), falling back to Web Audio: ${msg}`)
    }
  }

  const wavBase64 = await transcodeViaWebAudio(base64)
  return { base64: wavBase64, mime: 'audio/wav', ext: '.wav' }
}

/**
 * @deprecated 旧 API，保留向后兼容；新代码请用 {@link transcodeAudioBase64}
 */
export async function transcodeAudioBase64ToWav(base64: string, fileId?: string): Promise<string> {
  const { base64: out } = await transcodeAudioBase64(base64, fileId, 'wav')
  return out
}

async function transcodeViaWebAudio(base64: string): Promise<string> {
  const bytes = base64ToUint8Array(base64)
  const ctx = getAudioContext()
  const arrayBufferCopy = bytes.buffer.slice(0) as ArrayBuffer

  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBufferCopy)
    const wavBuffer = audioBufferToWav(audioBuffer)
    logger.debug('Audio transcoded via Web Audio API', {
      inputBytes: bytes.length,
      outputBytes: wavBuffer.byteLength,
      sampleRate: audioBuffer.sampleRate,
      numChannels: audioBuffer.numberOfChannels,
      durationSec: audioBuffer.duration
    })
    return arrayBufferToBase64(wavBuffer)
  } catch (webAudioErr) {
    const name = (webAudioErr as DOMException)?.name ?? 'Unknown'
    const message = (webAudioErr as DOMException)?.message ?? String(webAudioErr)
    throw new Error(
      `Web Audio decodeAudioData failed (${name}: ${message}). ` +
        `Electron Chromium 可能不支持该编码（常见于 AAC / m4a / opus），且无法调用 main 进程 ffmpeg。` +
        `请安装 ffmpeg 并加入 PATH，或上传 mp3 / wav 格式。`
    )
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode.apply(null, Array.from(sub))
  }
  return btoa(binary)
}

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.min(buffer.numberOfChannels, 2)
  const sampleRate = buffer.sampleRate
  const bitDepth = 16

  let samples: Float32Array
  if (numChannels === 2) {
    samples = interleave(buffer.getChannelData(0), buffer.getChannelData(1))
  } else {
    samples = buffer.getChannelData(0)
  }

  return encodeWav(samples, sampleRate, numChannels, bitDepth)
}

function interleave(left: Float32Array, right: Float32Array): Float32Array {
  const length = left.length + right.length
  const result = new Float32Array(length)
  let inputIndex = 0
  for (let i = 0; i < length; ) {
    result[i++] = left[inputIndex]
    result[i++] = right[inputIndex]
    inputIndex++
  }
  return result
}

function encodeWav(samples: Float32Array, sampleRate: number, numChannels: number, bitDepth: number): ArrayBuffer {
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  let offset = 0
  const writeString = (str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset++, str.charCodeAt(i))
  }

  writeString('RIFF')
  view.setUint32(offset, 36 + dataSize, true)
  offset += 4
  writeString('WAVE')
  writeString('fmt ')
  view.setUint32(offset, 16, true)
  offset += 4
  view.setUint16(offset, 1, true)
  offset += 2
  view.setUint16(offset, numChannels, true)
  offset += 2
  view.setUint32(offset, sampleRate, true)
  offset += 4
  view.setUint32(offset, sampleRate * blockAlign, true)
  offset += 4
  view.setUint16(offset, blockAlign, true)
  offset += 2
  view.setUint16(offset, bitDepth, true)
  offset += 2
  writeString('data')
  view.setUint32(offset, dataSize, true)
  offset += 4

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return buffer
}
