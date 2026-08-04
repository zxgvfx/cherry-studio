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
    const limit = finalFilter.limit || 100
    let offset = finalFilter.offset || 0
    const allModels: ApiModel[] = []
    let total = Infinity

    while (offset < total) {
      const pageFilter = { ...finalFilter, limit, offset }
      try {
        const res = await client.getModels(pageFilter)
        allModels.push(...(res.data || []))
        total = res.total ?? 0
        offset += limit
      } catch (error) {
        throw error
      }
    }
    return { data: allModels, total: allModels.length }
  }, [client, finalFilter])

  // @ts-ignore
  const isHoudini = typeof window !== 'undefined' && typeof window.api !== 'undefined'

  const [houdiniData, setHoudiniData] = useState<{ data: ApiModel[]; total: number } | null>(null)
  const [houdiniError, setHoudiniError] = useState<Error | null>(null)
  const [houdiniLoading, setHoudiniLoading] = useState(false)

  useEffect(() => {
    const executeFetch = async () => {
      if (isHoudini) {
        setHoudiniLoading(true)
        try {
          const result = await fetcher()
          setHoudiniData(result)
          setHoudiniError(null)
        } catch (err) {
          setHoudiniError(err as Error)
          setHoudiniData(null)
        } finally {
          setHoudiniLoading(false)
        }
      }
    }

    executeFetch()
  }, [isHoudini, path])

  const { data: swrData, error: swrError, isLoading: swrLoading } = useSWR(isHoudini ? null : path, fetcher)

  const data = isHoudini ? houdiniData : swrData
  const error = isHoudini ? houdiniError : swrError
  const isLoading = isHoudini ? houdiniLoading : swrLoading

  return {
    models: data?.data ?? [],
    error,
    isLoading
  }
}
