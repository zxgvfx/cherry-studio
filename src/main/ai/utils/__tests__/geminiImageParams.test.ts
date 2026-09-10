import { describe, expect, it } from 'vitest'

import {
  buildNewApiGeminiImageOptions,
  isGeminiStyleImageModel,
  isOpenAiGptImageModel,
  sanitizeGeminiImageParams,
  stripImageModelId
} from '../geminiImageParams'

describe('geminiImageParams', () => {
  it('recognizes nano banana ids with New API channel suffixes', () => {
    expect(stripImageModelId('nano-banana-pro@vapi')).toBe('nano-banana-pro')
    expect(isGeminiStyleImageModel('nano-banana-pro@vapi')).toBe(true)
    expect(isGeminiStyleImageModel('nano-banana-2@rc')).toBe(true)
    expect(isGeminiStyleImageModel('google/gemini-3-pro-image')).toBe(true)
    expect(isGeminiStyleImageModel('gpt-image-2@vapi')).toBe(false)
    expect(isOpenAiGptImageModel('gpt-image-2@vapi')).toBe(true)
    expect(isOpenAiGptImageModel('openai/gpt-image-1')).toBe(true)
    expect(isOpenAiGptImageModel('nano-banana-pro@vapi')).toBe(false)
  })

  it('drops DALL·E 1792x1024 and maps it to 16:9 for Gemini-style models', () => {
    expect(sanitizeGeminiImageParams('nano-banana-pro@vapi', { size: '1792x1024', n: 1 })).toEqual({
      n: 1,
      aspectRatio: '16:9'
    })
  })

  it('does not rewrite size for OpenAI image models', () => {
    expect(sanitizeGeminiImageParams('dall-e-3', { size: '1792x1024' })).toEqual({ size: '1792x1024' })
  })

  it('rewrites leftover DALL·E size into New API extra_body imageConfig', () => {
    expect(buildNewApiGeminiImageOptions({ size: '1792x1024' })).toEqual({
      size: undefined,
      aspectRatio: '16:9',
      extraBody: { generationConfig: { imageConfig: { aspectRatio: '16:9' } } }
    })
  })

  it('keeps 1K/2K/4K in imageConfig and never sends a pixel size', () => {
    expect(buildNewApiGeminiImageOptions({ aspectRatio: '9:16', imageSize: '2K', size: '1024x1792' })).toEqual({
      size: undefined,
      aspectRatio: '9:16',
      extraBody: { generationConfig: { imageConfig: { aspectRatio: '9:16', imageSize: '2K' } } }
    })
  })
})
