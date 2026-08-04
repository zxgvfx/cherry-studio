import { describe, expect, it } from 'vitest'

import {
  buildImageEditInstruction,
  computeSourceImageSize,
  createImageEditFormData,
  preferSourceImageSize,
  resolveGptImageOutputSize,
  selectPrimaryReference
} from '../imageGenerationUtils'

describe('image generation reference utilities', () => {
  it('selects the first user image as the target reference', () => {
    expect(selectPrimaryReference(['user-first', 'user-second'], ['assistant-first'])).toEqual({
      reference: 'user-first',
      source: 'user'
    })
  })

  it('falls back to the first assistant image when the user supplied none', () => {
    expect(selectPrimaryReference<string>([], ['assistant-first', 'assistant-second'])).toEqual({
      reference: 'assistant-first',
      source: 'assistant'
    })
  })

  it('tells the model to edit the first image and use later images only as references', () => {
    expect(buildImageEditInstruction(5)).toContain('image 1 is the only target image to edit')
    expect(buildImageEditInstruction(5)).toContain('Images 2-5 are reference images only')
  })

  it('serializes every reference as a repeated image multipart field', () => {
    const formData = createImageEditFormData({ model: 'gpt-image-2@rc', quality: 'high' }, [
      new File(['first'], 'target.jpg', { type: 'image/jpeg' }),
      new File(['second'], 'reference.png', { type: 'image/png' })
    ])

    expect([...formData.keys()]).toEqual(['model', 'quality', 'image', 'image'])
    expect(formData.getAll('image')).toHaveLength(2)
    expect(formData.getAll('image[]')).toHaveLength(0)
  })

  it('preserves a landscape reference aspect ratio at the selected tier', () => {
    expect(computeSourceImageSize({ width: 1920, height: 1080 }, '1k')).toBe('1024x576')
  })

  it('preserves a portrait reference aspect ratio at the selected tier', () => {
    expect(computeSourceImageSize({ width: 1080, height: 1920 }, '2k')).toBe('1152x2048')
  })

  it('uses 1K when no resolution tier was selected', () => {
    expect(computeSourceImageSize({ width: 1024, height: 1024 }, 'auto')).toBe('1024x1024')
    expect(computeSourceImageSize({ width: 1024, height: 1024 }, undefined)).toBe('1024x1024')
  })

  it('keeps the configured size when the primary image dimensions are unavailable', () => {
    expect(preferSourceImageSize(undefined, '1536x1024')).toBe('1536x1024')
  })
})

describe('resolveGptImageOutputSize', () => {
  it('uses explicit aspect + tier (2k square)', () => {
    expect(
      resolveGptImageOutputSize({
        aspectRatio: '1:1',
        resolutionTier: '2k',
        quality: 'low'
      } as never)
    ).toBe('2048x2048')
  })

  it('follows source aspect when ratio is auto and tier is 2k', () => {
    expect(
      resolveGptImageOutputSize({ aspectRatio: 'auto', resolutionTier: '2k', quality: 'low' } as never, {
        width: 1920,
        height: 1080
      })
    ).toBe('2048x1152')
  })

  it('falls back to 1:1 at tier for text-to-image when ratio is auto', () => {
    expect(
      resolveGptImageOutputSize({
        aspectRatio: 'auto',
        resolutionTier: '2k',
        quality: 'low'
      } as never)
    ).toBe('2048x2048')
  })

  it('omits size when both aspect and tier are auto', () => {
    expect(
      resolveGptImageOutputSize({
        aspectRatio: 'auto',
        resolutionTier: 'auto'
      } as never)
    ).toBeUndefined()
  })
})
