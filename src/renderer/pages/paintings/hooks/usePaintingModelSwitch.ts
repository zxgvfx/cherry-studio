import { loggerService } from '@logger'
import { useModels } from '@renderer/hooks/useModel'
import type { Model } from '@shared/data/types/model'
import { isEditImageModel } from '@shared/utils/model'
import { useCallback } from 'react'

import { presentPaintingGenerateError } from '../errors/paintingGenerateError'
import { createDefaultPainting } from '../model/paintingPipeline'
import type { PaintingData } from '../model/types/paintingData'
import type { ModelOption } from '../model/types/paintingModel'
import { computeModelFieldReset } from '../utils/computeModelFieldReset'
import { tabToImageGenerationMode } from '../utils/paintingProviderMode'

const logger = loggerService.withContext('paintings/usePaintingModelSwitch')

interface UsePaintingModelSwitchInput {
  painting: PaintingData
  onPaintingChange: (updates: Partial<PaintingData>) => void
  ensureProviderCatalog: (providerId: string) => Promise<ModelOption[]>
}

export type PaintingModelSelection = { providerId: string; modelId: string }

export function usePaintingModelSwitch({
  painting,
  onPaintingChange,
  ensureProviderCatalog
}: UsePaintingModelSwitchInput) {
  const currentProviderId = painting.providerId
  const { models } = useModels(currentProviderId ? { providerId: currentProviderId } : undefined)

  return useCallback(
    async ({ providerId, modelId }: PaintingModelSelection) => {
      if (providerId === currentProviderId) {
        // Reset stale fields the old model wrote but the new one doesn't
        // accept — the form writes into `painting.params`, so the reset
        // patch lives there too. Form-hiding is driven by the new model's
        // registry block; this brings the underlying values in sync.
        // Returns `{}` when either model is unknown to the registry, so
        // custom-id paintings stay untouched.
        const resetPatch = await computeModelFieldReset({
          providerId: currentProviderId,
          oldModelId: painting.model,
          newModelId: modelId,
          mode: tabToImageGenerationMode(painting.mode),
          currentValues: painting.params ?? {}
        })
        // Drop attached input images when the target model can't accept them:
        // the prompt-bar upload UI is gated on `isEditImageModel`, so a hidden
        // attachment left over from an edit model would otherwise still be
        // sent to a generate-only model. `onPaintingChange` merges, so the
        // clear must be explicit.
        const nextModel = models.find((model) => model.apiModelId === modelId)
        // Unknown target → keep until CLEAR sees accept→reject; only drop when
        // the resolved model is known not to accept image inputs.
        const keepInputFiles = !nextModel || isEditImageModel(nextModel)
        onPaintingChange({
          params: { ...painting.params, ...resetPatch },
          model: modelId,
          ...(keepInputFiles ? {} : { inputFiles: [] })
        } as Partial<PaintingData>)
        return
      }

      // Apply provider+model immediately so the trigger stops showing the previous
      // channel's identically-named model (gpt-image-2 on rightcode vs vapi) while
      // the destination catalog loads. Catalog failure still surfaces an error, but
      // the selection the user clicked is kept.
      onPaintingChange({
        providerId,
        model: modelId
      } as Partial<PaintingData>)

      let catalog: ModelOption[]
      try {
        catalog = await ensureProviderCatalog(providerId)
      } catch (error) {
        logger.error('Failed to load provider catalog on model switch', error as Error)
        presentPaintingGenerateError(error)
        return
      }
      const targetPainting = createDefaultPainting({ providerId })
      const nextOption = catalog.find((option) => String(option.value || '').trim() === modelId)
      const nextModel = nextOption?.raw as Model | undefined
      const keepInputFiles = nextModel ? isEditImageModel(nextModel) : false

      onPaintingChange({
        ...targetPainting,
        id: painting.id,
        files: painting.files,
        prompt: painting.prompt,
        providerId,
        mode: 'generate',
        model: modelId,
        // Keep reference images when the destination model still accepts them
        // (edit-capable). Generate-only / unknown targets get a clean slate.
        inputFiles: keepInputFiles ? (painting.inputFiles ?? []) : []
      } as Partial<PaintingData>)
    },
    [currentProviderId, ensureProviderCatalog, models, onPaintingChange, painting]
  )
}
