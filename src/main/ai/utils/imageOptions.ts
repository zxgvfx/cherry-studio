import type { ParamValues } from '@cherrystudio/provider-registry'

import { nativeBindingFor } from './aiSdkNativeBindings'
import { isOpenAiGptImageModel } from './geminiImageParams'

/** The structured fields + leftover vendor bag split out of a canonical `paramValues` bag. */
export interface SplitImageParams {
  /** The binding-mapped structured fields — typed straight from the catalog
   *  (`ParamValues`), `+ n` (the `numImages → n` rename). No hand-maintained
   *  param-shape type. */
  readonly structured: ParamValues & { n?: number }
  /** Non-binding canonical keys (cfg, addWatermark, modelDescriptor, …). */
  readonly vendorBag: Record<string, unknown>
}

/**
 * Partition a canonical `paramValues` bag into the structured fields the AI SDK
 * call consumes (via `AI_SDK_NATIVE_BINDINGS`) vs the leftover vendor bag the
 * WireProfile engine (`buildVendorProviderOptions`) forwards. The inverse of the
 * renderer's old `canonicalGenerate` partition, moved to main after the IPC
 * payload collapse.
 *
 * The `'' | null | undefined` skip mirrors the renderer's old `place()` guard
 * exactly — it is the byte-identical-wire invariant (e.g. an empty-string `size`
 * must NOT survive to `resolveImageRequestSize`).
 */
export function splitParamValues(paramValues: Record<string, unknown>): SplitImageParams {
  const structured: Record<string, unknown> = {}
  const vendorBag: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(paramValues)) {
    if (value === undefined || value === '' || value === null) continue
    const binding = nativeBindingFor(key) // numImages → n; aspectRatio normalized once; rest identity
    if (binding) {
      const mapped = binding.map ? binding.map(value) : value
      if (mapped !== undefined && mapped !== null && mapped !== '') structured[binding.option] = mapped
    } else {
      vendorBag[key] = value
    }
  }
  return { structured: structured as ParamValues & { n?: number }, vendorBag }
}

/**
 * Resolve the wire `size`.
 *
 * Painting UI uses `'auto'` to mean "let the server pick". Doubao / Gemini-style
 * relays reject that sentinel (and a blanket `1024x1024`), so it is omitted for
 * those models. OpenAI `gpt-image-*` (including NewAPI/Higress `@vapi` edits)
 * require `size` to be present as `'auto'` or `WxH` — omitting it 500s with
 * "请传递 size 参数，支持 auto 或具体图片宽高".
 */
export function resolveImageRequestSize(size: string | undefined, modelId: string): string | undefined {
  if (isOpenAiGptImageModel(modelId)) {
    return !size || size === 'auto' ? 'auto' : size
  }
  return size === 'auto' ? undefined : size
}
