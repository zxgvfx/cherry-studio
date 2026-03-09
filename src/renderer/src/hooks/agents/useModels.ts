import type { ApiModel, ApiModelsFilter } from '@renderer/types'
import { merge } from 'lodash'
import { useCallback, useEffect, useState } from 'react'
import useSWR from 'swr'

import { useAgentClient } from './useAgentClient'

export const useApiModels = (filter?: ApiModelsFilter) => {
  const client = useAgentClient()
  // const defaultFilter = { limit: -1 } satisfies ApiModelsFilter
  const defaultFilter = {} satisfies ApiModelsFilter
  const finalFilter = merge(filter, defaultFilter)
  const path = client.getModelsPath(finalFilter)
  const fetcher = useCallback(async () => {
    console.error('[Houdini Debug useApiModels] Fetcher called with filter:', JSON.stringify(finalFilter))
    const limit = finalFilter.limit || 100
    let offset = finalFilter.offset || 0
    const allModels: ApiModel[] = []
    let total = Infinity

    while (offset < total) {
      const pageFilter = { ...finalFilter, limit, offset }
      console.error('[Houdini Debug useApiModels] Calling client.getModels with:', JSON.stringify(pageFilter))
      try {
      const res = await client.getModels(pageFilter)
        console.error('[Houdini Debug useApiModels] Received response:', JSON.stringify({
          dataCount: res.data?.length || 0,
          total: res.total,
          firstModel: res.data?.[0]?.id
        }))
      allModels.push(...(res.data || []))
      total = res.total ?? 0
      offset += limit
      } catch (error) {
        console.error('[Houdini Debug useApiModels] ⚠️ client.getModels threw error:', (error as Error)?.message || String(error))
        console.error('[Houdini Debug useApiModels] ⚠️ Error stack:', (error as Error)?.stack)
        throw error
      }
    }
    console.error('[Houdini Debug useApiModels] Returning allModels count:', allModels.length)
    return { data: allModels, total: allModels.length }
  }, [client, finalFilter])
  
  // CRITICAL FIX: For Houdini environment, completely bypass SWR and fetch directly
  // @ts-ignore
  const isHoudini = typeof window !== 'undefined' && typeof window.api !== 'undefined'
  
  console.error('[Houdini Debug useApiModels] isHoudini check:', JSON.stringify({ 
    hasWindow: typeof window !== 'undefined',
    hasWindowApi: typeof (window as any)?.api !== 'undefined',
    isHoudini
  }))
  
  // Houdini-specific: Use useState + useEffect instead of SWR
  const [houdiniData, setHoudiniData] = useState<{ data: ApiModel[]; total: number } | null>(null)
  const [houdiniError, setHoudiniError] = useState<Error | null>(null)
  const [houdiniLoading, setHoudiniLoading] = useState(false)
  
  useEffect(() => {
    // Force immediate execution for debugging
    const executeFetch = async () => {
      console.error('[Houdini Debug useApiModels] ==> useEffect triggered, isHoudini:', isHoudini, 'path:', path)
      if (isHoudini) {
        console.error('[Houdini Debug useApiModels] ==> Houdini mode: fetching directly, bypassing SWR')
        setHoudiniLoading(true)
        try {
          const result = await fetcher()
          console.error('[Houdini Debug useApiModels] ==> Houdini mode: fetch successful, models:', result.data.length)
          console.error('[Houdini Debug useApiModels] ==> First model:', result.data[0]?.id)
          setHoudiniData(result)
          setHoudiniError(null)
        } catch (err) {
          console.error('[Houdini Debug useApiModels] ==> Houdini mode: fetch failed:', (err as Error)?.message || String(err))
          setHoudiniError(err as Error)
          setHoudiniData(null)
        } finally {
          console.error('[Houdini Debug useApiModels] ==> Fetch completed')
          setHoudiniLoading(false)
        }
      } else {
        console.error('[Houdini Debug useApiModels] ==> Not Houdini mode, using SWR')
      }
    }
    
    executeFetch()
  }, [isHoudini, path])
  
  // For non-Houdini (Electron), use normal SWR
  const { data: swrData, error: swrError, isLoading: swrLoading } = useSWR(
    isHoudini ? null : path, // Disable SWR in Houdini by passing null as key
    fetcher
  )
  
  const data = isHoudini ? houdiniData : swrData
  const error = isHoudini ? houdiniError : swrError
  const isLoading = isHoudini ? houdiniLoading : swrLoading
  
  console.error('[Houdini Debug useApiModels] Hook returning:', JSON.stringify({
    isHoudini,
    modelsCount: data?.data?.length ?? 0,
    errorMsg: error?.message,
    isLoading,
    path
  }))
  
  return {
    models: data?.data ?? [],
    error,
    isLoading
  }
}
