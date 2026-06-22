/**
 * 模型能力检查模块
 * 检查不同模型支持的功能（PDF输入、图片输入、大文件上传等）
 */

import { hasProviderConfig } from '@cherrystudio/ai-core/provider'
import { isVisionModel } from '@renderer/config/models'
import { getProviderByModel } from '@renderer/services/AssistantService'
import type { FileType, Model } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'

import { getAiSdkProviderId } from '../provider/factory'

// 工具函数：基于模型名和提供商判断是否支持某特性
function modelSupportValidator(
  model: Model,
  {
    supportedModels = [],
    unsupportedModels = [],
    supportedProviders = [],
    unsupportedProviders = []
  }: {
    supportedModels?: string[]
    unsupportedModels?: string[]
    supportedProviders?: string[]
    unsupportedProviders?: string[]
  }
): boolean {
  const provider = getProviderByModel(model)
  const aiSdkId = getAiSdkProviderId(provider)

  // 黑名单：命中不支持的模型直接拒绝
  if (unsupportedModels.some((name) => model.name.includes(name))) {
    return false
  }

  // 黑名单：命中不支持的提供商直接拒绝，常用于某些提供商的同名模型并不具备原模型的某些特性
  if (unsupportedProviders.includes(aiSdkId)) {
    return false
  }

  // 白名单：命中支持的模型名
  if (supportedModels.some((name) => model.name.includes(name))) {
    return true
  }

  // 回退到提供商判断
  return supportedProviders.includes(aiSdkId)
}

/**
 * 检查模型是否支持原生PDF输入
 */
export function supportsPdfInput(model: Model): boolean {
  // 中心化模型走 Higress 代理，不支持原生 file content part
  if ((model as any).isCentralized) return false

  // 通过 centralized- provider 的模型也不支持原生 PDF
  const provider = getProviderByModel(model)
  if (provider?.id?.startsWith('centralized-')) return false

  return modelSupportValidator(model, {
    supportedModels: ['qwen-long', 'qwen-doc'],
    supportedProviders: [
      'openai',
      'azure-openai',
      'anthropic',
      'google',
      'google-generative-ai',
      'google-vertex',
      'bedrock',
      'amazon-bedrock'
    ]
  })
}

/**
 * 检查模型是否支持原生图片输入
 */
export function supportsImageInput(model: Model): boolean {
  return isVisionModel(model)
}

/**
 * 检查模型是否支持原生音频输入（多模态 / Omni 等视觉模型）
 */
export function supportsAudioInput(model: Model): boolean {
  if (!isVisionModel(model)) return false
  return getSupportedAudioExts(model).length > 0
}

/**
 * 模型本身具备视频理解能力的 id/name 特征（用于 OpenAI 兼容网关通道）。
 * 网关（Higress / new-api 等）会把 OpenAI file content part 转成上游原生视频输入，
 * 但前提是上游模型本身支持视频（如 Gemini、Doubao Seed、Qwen-VL/Omni、GLM-4V）。
 */
const OPENAI_COMPAT_VIDEO_MODEL_REGEX = /gemini|doubao-seed|qwen[\w.-]*(?:vl|omni)|glm-4(?:\.\d)?v|internvl/i

/**
 * 检查模型是否支持原生视频输入。
 *
 * - Google Gemini / Vertex 原生通道直接支持（AI SDK file part -> inlineData）
 * - openai-compatible 通道（含中心化 / 自定义 OpenAI 兼容网关，在 providerConfig 中
 *   fallback 到 openai-compatible）：已通过 patch 将 video file part 序列化为
 *   OpenAI file 扩展格式 { type: 'file', file: { filename, file_data } }。
 *   开放条件（任一）：
 *     1. 中心化配置里模型显式标注 "supports_video_input": true/false（最高优先级）
 *     2. 模型 id/name 命中已知视频理解模型特征（如 gemini-3.5-flash），且为视觉模型
 * - 其它通道保持保守，不支持
 */
export function supportsVideoInput(model: Model): boolean {
  const provider = getProviderByModel(model)
  const aiSdkId = getAiSdkProviderId(provider)

  if (['google', 'google-generative-ai', 'google-vertex'].includes(aiSdkId)) {
    return true
  }

  const routesToOpenAiCompatible = aiSdkId === 'openai-compatible' || !hasProviderConfig(aiSdkId)
  if (routesToOpenAiCompatible) {
    // 中心化配置显式标注优先（与 supported_text_delta 一样直接透传到 model 对象上）
    const explicit = (model as any).supports_video_input
    if (typeof explicit === 'boolean') {
      return explicit
    }

    return (
      isVisionModel(model) &&
      (OPENAI_COMPAT_VIDEO_MODEL_REGEX.test(model.id) || OPENAI_COMPAT_VIDEO_MODEL_REGEX.test(model.name))
    )
  }

  return false
}

/**
 * Provider 通道原生（即无需转码）就能接收的音频扩展名。
 *
 * - 原生 Google Gemini（@ai-sdk/google）支持 mp3/wav/ogg/flac/aac/m4a
 * - OpenAI / openai-compatible（含一切 provider.type === 'openai' 的自定义 / 中心化 provider，
 *   它们在 providerConfig 里 fallback 到 openai-compatible 通道）仅支持 mp3、wav（input_audio）
 * - 其它通道暂不支持
 */
export function getProviderNativeAudioExts(model: Model): string[] {
  const provider = getProviderByModel(model)
  const aiSdkId = getAiSdkProviderId(provider)

  if (['google', 'google-generative-ai', 'google-vertex'].includes(aiSdkId)) {
    return ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a']
  }

  const isOpenAiLike =
    aiSdkId === 'openai' ||
    aiSdkId === 'openai-chat' ||
    aiSdkId === 'openai-compatible' ||
    aiSdkId === 'github-copilot-openai-compatible' ||
    aiSdkId === 'azure' ||
    aiSdkId === 'cherryin-chat' ||
    // 兜底：所有 type 为 openai 的 provider（包括中心化/自定义 OpenAI 兼容网关）
    // 在 providerConfig.ts 里实际都会路由到 openai-compatible 通道
    provider?.type === 'openai'

  if (isOpenAiLike) {
    return ['.mp3', '.wav']
  }

  return []
}

/**
 * 返回当前模型在 UI 上可以上传的音频扩展名列表。
 *
 * 比 `getProviderNativeAudioExts` 更宽松：当 provider 至少支持 wav 时，UI
 * 允许用户上传所有浏览器能够解码的常见音频格式（m4a/aac/ogg/flac/mp3/wav），
 * 发送时通过 Web Audio API 客户端转码到 wav。
 */
export function getSupportedAudioExts(model: Model): string[] {
  if (!isVisionModel(model)) return []

  const nativeExts = getProviderNativeAudioExts(model)
  if (nativeExts.length === 0) return []

  // 只要 provider 接受 wav（绝大多数情况），就允许上传所有可由浏览器解码后转码为 wav 的格式
  if (nativeExts.includes('.wav')) {
    return ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']
  }

  return nativeExts
}

/**
 * 检查提供商是否支持大文件上传（如Gemini File API）
 */
export function supportsLargeFileUpload(model: Model): boolean {
  // 基于AI SDK文档，以下模型或提供商支持大文件上传
  return modelSupportValidator(model, {
    supportedModels: ['qwen-long', 'qwen-doc'],
    supportedProviders: ['google', 'google-generative-ai', 'google-vertex']
  })
}

/**
 * 获取提供商特定的文件大小限制
 */
export function getFileSizeLimit(model: Model, fileType: FileType): number {
  const provider = getProviderByModel(model)
  const aiSdkId = getAiSdkProviderId(provider)

  // Anthropic PDF限制32MB
  if (aiSdkId === 'anthropic' && fileType === FILE_TYPE.DOCUMENT) {
    return 32 * 1024 * 1024 // 32MB
  }

  // Gemini小文件限制20MB（超过此限制会使用File API上传）
  if (['google', 'google-generative-ai', 'google-vertex'].includes(aiSdkId)) {
    return 20 * 1024 * 1024 // 20MB
  }

  // Dashscope如果模型支持大文件上传优先使用File API上传
  if (aiSdkId === 'dashscope' && supportsLargeFileUpload(model)) {
    return 0 // 使用较小的默认值
  }

  // 视频走 base64 内联发送，与 Gemini inline data 上限保持一致；
  // 过大的请求体也容易被网关 client_max_body_size 拦截（413）
  if (fileType === FILE_TYPE.VIDEO) {
    return 20 * 1024 * 1024 // 20MB
  }

  // 其他提供商没有明确限制，使用较大的默认值
  // 这与Legacy架构中的实现一致，让提供商自行处理文件大小
  return Infinity
}
