import { loggerService } from '@logger'
import { isMac } from '@renderer/config/constant'
import { isLocalAi } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import db from '@renderer/databases'
import i18n, { setDayjsLocale } from '@renderer/i18n'
import KnowledgeQueue from '@renderer/queue/KnowledgeQueue'
import MemoryService from '@renderer/services/MemoryService'
import { handleSaveData, useAppDispatch, useAppSelector } from '@renderer/store'
import { selectMemoryConfig } from '@renderer/store/memory'
import { setAvatar, setFilesPath, setResourcesPath, setUpdateState } from '@renderer/store/runtime'
import { addModel, updateModel, addProvider, initialState } from '@renderer/store/llm'
import { addMCPServer, updateMCPServer } from '@renderer/store/mcp'
import { addWebSearchProvider, updateWebSearchProvider } from '@renderer/store/websearch'
import {
  type ToolPermissionRequestPayload,
  type ToolPermissionResultPayload,
  toolPermissionsActions
} from '@renderer/store/toolPermissions'
import { delay, runAsyncFunction } from '@renderer/utils'
import { checkDataLimit } from '@renderer/utils'
import { sendToolApprovalNotification } from '@renderer/utils/userConfirmation'
import { defaultLanguage } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { useDefaultModel } from './useAssistant'
import useFullScreenNotice from './useFullScreenNotice'
import { useRuntime } from './useRuntime'
import { useEnableDeveloperMode, useNavbarPosition, useSettings } from './useSettings'
import useUpdateHandler from './useUpdateHandler'

const logger = loggerService.withContext('useAppInit')

export function useAppInit() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const {
    proxyUrl,
    proxyBypassRules,
    language,
    windowStyle,
    autoCheckUpdate,
    proxyMode,
    customCss,
    enableDataCollection
  } = useSettings()
  const { isLeftNavbar } = useNavbarPosition()
  const { minappShow } = useRuntime()
  const { setDefaultModel, setQuickModel, setTranslateModel } = useDefaultModel()
  const avatar = useLiveQuery(() => db.settings.get('image://avatar'))
  const { theme } = useTheme()
  const { enableDeveloperMode, setEnableDeveloperMode: setDevMode } = useEnableDeveloperMode()
  const memoryConfig = useAppSelector(selectMemoryConfig)
  const providers = useAppSelector((state) => state.llm.providers)

  useEffect(() => {
    document.getElementById('spinner')?.remove()
    // eslint-disable-next-line no-restricted-syntax
    console.timeEnd('init')

    // Initialize MemoryService after app is ready
    MemoryService.getInstance()

    // 加载中心化配置
    const loadCentralizedConfig = async () => {
      try {
        const config = await window.api.config.getMergedConfig()
        // getMergedConfig 返回的是对象，不是 JSON 字符串，electron_injector 已经 parse 过了
        // 但在 API 存根中是返回 str，这里需要小心
        // 在 electron_injector.py 中，我们修改了 getMergedConfig: async () => ... return result ? JSON.parse(result) : null;
        // 所以这里拿到的是对象
        
        if (!config) return

        const centralizedProviders = config.centralizedProviders || []
        const centralizedMcpServers = config.centralizedMcpServers || []
        // Fallback for old config structure (single provider)
        const oldCentralizedModels = config.centralizedModels || []
        const oldCentralizedProvider = config.centralizedProvider
        
        // Handle new multi-provider structure
        if (centralizedProviders.length > 0) {
            logger.info('Loading centralized providers:', centralizedProviders)
            centralizedProviders.forEach((cProvider: any) => {
                const providerId = cProvider.id || 'centralized-unknown'
                
                // Check if provider exists (by ID)
                const hasProvider = providers.some(p => p.id === providerId)
                if (!hasProvider) {
                    dispatch(addProvider({
                        id: providerId,
                        name: cProvider.name || 'Centralized',
                        type: cProvider.type || 'openai',
                        apiKey: cProvider.apiKey || '',
                        apiHost: cProvider.apiHost || '',
                        models: [],
                        enabled: true,
                        isSystem: true,
                        icon: cProvider.icon,
                        isCentralized: true // Mark provider as centralized
                    }))
                } else {
                   // Update existing provider (e.g. if config changed)
                   // But be careful not to overwrite user settings if they share ID (unlikely for centralized IDs)
                   // dispatch(updateProvider({ ...cProvider, id: providerId, isCentralized: true }))
                }
                
                // Add models for this provider
                if (cProvider.models && Array.isArray(cProvider.models)) {
                    cProvider.models.forEach((model: any) => {
                        const modelWithFlag = { ...model, provider: providerId, isCentralized: true, group: cProvider.name || 'Centralized' }
                        dispatch(updateModel({ providerId: providerId, model: modelWithFlag }))
                        dispatch(addModel({ providerId: providerId, model: modelWithFlag }))
                    })
                }
            })
        }
        
        // Handle backward compatibility or mix (old structure)
        if (oldCentralizedModels.length > 0) {
          // Use config from centralized-config.json if available, otherwise default
          const centralizedProviderConfig = oldCentralizedProvider || {}
          const centralizedProviderId = centralizedProviderConfig.id || 'centralized'
          const centralizedProviderName = centralizedProviderConfig.name || 'Centralized'
          const centralizedProviderIcon = centralizedProviderConfig.icon
          
          const hasCentralizedProvider = providers.some(p => p.id === centralizedProviderId)
          if (!hasCentralizedProvider) {
             dispatch(addProvider({
                id: centralizedProviderId,
                name: centralizedProviderName,
                type: 'openai', 
                apiKey: 'placeholder',
                apiHost: '',
                models: [],
                enabled: true,
                isSystem: true,
                icon: centralizedProviderIcon,
                isCentralized: true
             }))
          }

          oldCentralizedModels.forEach((model: any) => {
            const modelWithFlag = { ...model, isCentralized: true }
            if (model.group === 'Centralized' || model.group === centralizedProviderName || model.group === centralizedProviderId) {
               dispatch(updateModel({ providerId: centralizedProviderId, model: modelWithFlag }))
               dispatch(addModel({ providerId: centralizedProviderId, model: modelWithFlag }))
            } else if (model.provider) {
               dispatch(updateModel({ providerId: model.provider, model: modelWithFlag }))
               dispatch(addModel({ providerId: model.provider, model: modelWithFlag }))
            }
          })
        }
        
        // Handle centralized MCP servers
        if (centralizedMcpServers.length > 0) {
            logger.info('Loading centralized MCP servers:', centralizedMcpServers)
            centralizedMcpServers.forEach((mcpServer: any) => {
                const serverWithFlag = { ...mcpServer, isCentralized: true }
                // Try to update existing server, then add if not exists
                dispatch(updateMCPServer(serverWithFlag))
                dispatch(addMCPServer(serverWithFlag))
            })
        }

        // Handle centralized web search providers
        const centralizedWebSearchProviders = config.centralizedWebSearchProviders || []
        if (centralizedWebSearchProviders.length > 0) {
            logger.info('Loading centralized web search providers:', centralizedWebSearchProviders)
            centralizedWebSearchProviders.forEach((provider: any) => {
                // Ensure provider has an ID
                if (provider.id) {
                    const providerWithFlag = { ...provider, isCentralized: true }
                    dispatch(updateWebSearchProvider(providerWithFlag))
                    dispatch(addWebSearchProvider(providerWithFlag))
                } else {
                    logger.warn('Skipping centralized web search provider without ID:', provider)
                }
            })
        }

        // 等待模型加载完成后，处理默认模型配置
        await delay(0.2) // 给 Redux 更多时间更新
        
        // Handle default models from centralized config
        const defaultModels = config.defaultModels || {}
        if (Object.keys(defaultModels).length > 0) {
          logger.info('Found centralized default models config:', defaultModels)
          
          // 获取当前 Redux store 中的 llm state
          const currentState = window.store?.getState?.()?.llm
          
          if (!currentState) {
            logger.warn('Redux store not ready, skipping default models setup')
            return
          }
          
          // 辅助函数：检查用户是否设置了模型（不是初始值）
          const isUserSetModel = (currentModel: any, initialModel: any) => {
            if (!currentModel || !initialModel) return false
            return currentModel.id !== initialModel.id
          }
          
          // 辅助函数：根据 model ID 在所有 providers 中查找模型
          const findModelById = (modelConfig: string | { id: string; provider?: string }, providers: any[]) => {
            const targetId = typeof modelConfig === 'string' ? modelConfig : modelConfig.id
            const targetProvider = typeof modelConfig === 'string' ? undefined : modelConfig.provider

            for (const provider of providers) {
              // 如果指定了 provider，先检查 provider id 是否匹配
              if (targetProvider && provider.id !== targetProvider) {
                continue
              }
              const model = provider.models?.find((m: any) => m.id === targetId)
              if (model) return model
            }
            return null
          }
          
          // 获取初始默认模型（用于判断用户是否修改过）
          const initialDefaultModel = initialState.defaultModel
          const initialQuickModel = initialState.quickModel
          const initialTranslateModel = initialState.translateModel
          
          // 获取所有 providers（包括刚加载的中心化 providers）
          const allProviders = currentState.providers || []
          
          logger.info(`Current providers count: ${allProviders.length}`)
          logger.info(`Looking for models: default=${defaultModels.defaultModel}, quick=${defaultModels.quickModel}, translate=${defaultModels.translateModel}`)
          
          // 如果用户没有设置 defaultModel，使用中心化配置
          if (defaultModels.defaultModel) {
            const hasUserSetDefaultModel = isUserSetModel(currentState.defaultModel, initialDefaultModel)
            logger.info(`User has set defaultModel: ${hasUserSetDefaultModel}, current: ${currentState.defaultModel?.id}, initial: ${initialDefaultModel?.id}`)
            
            if (!hasUserSetDefaultModel) {
              const centralizedDefaultModel = findModelById(defaultModels.defaultModel, allProviders)
              if (centralizedDefaultModel) {
                logger.info('✓ Setting centralized default model:', centralizedDefaultModel.name)
                setDefaultModel(centralizedDefaultModel)
              } else {
                logger.warn(`✗ Model not found: ${defaultModels.defaultModel}`)
              }
            } else {
              logger.info('User has custom defaultModel, skipping centralized config')
            }
          }
          
          // 如果用户没有设置 quickModel，使用中心化配置
          if (defaultModels.quickModel) {
            const hasUserSetQuickModel = isUserSetModel(currentState.quickModel, initialQuickModel)
            logger.info(`User has set quickModel: ${hasUserSetQuickModel}, current: ${currentState.quickModel?.id}, initial: ${initialQuickModel?.id}`)
            
            if (!hasUserSetQuickModel) {
              const centralizedQuickModel = findModelById(defaultModels.quickModel, allProviders)
              if (centralizedQuickModel) {
                logger.info('✓ Setting centralized quick model:', centralizedQuickModel.name)
                setQuickModel(centralizedQuickModel)
              } else {
                logger.warn(`✗ Model not found: ${defaultModels.quickModel}`)
              }
            } else {
              logger.info('User has custom quickModel, skipping centralized config')
            }
          }
          
          // 如果用户没有设置 translateModel，使用中心化配置
          if (defaultModels.translateModel) {
            const hasUserSetTranslateModel = isUserSetModel(currentState.translateModel, initialTranslateModel)
            logger.info(`User has set translateModel: ${hasUserSetTranslateModel}, current: ${currentState.translateModel?.id}, initial: ${initialTranslateModel?.id}`)
            
            if (!hasUserSetTranslateModel) {
              const centralizedTranslateModel = findModelById(defaultModels.translateModel, allProviders)
              if (centralizedTranslateModel) {
                logger.info('✓ Setting centralized translate model:', centralizedTranslateModel.name)
                setTranslateModel(centralizedTranslateModel)
              } else {
                logger.warn(`✗ Model not found: ${defaultModels.translateModel}`)
              }
            } else {
              logger.info('User has custom translateModel, skipping centralized config')
            }
          }
        } else {
          logger.info('No defaultModels in centralized config')
        }
      } catch (error) {
        logger.error('Failed to load centralized config:', error as Error)
      }
    }
    
    loadCentralizedConfig()
  }, [])

  useEffect(() => {
    if (!enableDeveloperMode) return
    const backendUrl = (window as any).__CHERRY_BACKEND_URL || ''
    fetch(backendUrl + '/api/v1/config/check-developer-status')
      .then((r) => r.json())
      .then((data) => {
        if (!data.allowed) {
          logger.info('Current user removed from developer whitelist, disabling developer mode')
          setDevMode(false)
        }
      })
      .catch((e) => logger.warn('Failed to check developer status:', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    window.api.getDataPathFromArgs().then((dataPath) => {
      if (dataPath) {
        window.navigate('/settings/data', { replace: true })
      }
    })
  }, [])

  useEffect(() => {
    window.electron.ipcRenderer.on(IpcChannel.App_SaveData, async () => {
      await handleSaveData()
    })
  }, [])

  useUpdateHandler()
  useFullScreenNotice()

  useEffect(() => {
    avatar?.value && dispatch(setAvatar(avatar.value))
  }, [avatar, dispatch])

  useEffect(() => {
    const checkForUpdates = async () => {
      const { isPackaged } = await window.api.getAppInfo()

      if (!isPackaged || !autoCheckUpdate) {
        return
      }

      const { updateInfo } = await window.api.checkForUpdate()
      dispatch(setUpdateState({ info: updateInfo }))
    }

    // Initial check with delay
    runAsyncFunction(async () => {
      const { isPackaged } = await window.api.getAppInfo()
      if (isPackaged && autoCheckUpdate) {
        await delay(2)
        await checkForUpdates()
      }
    })

    // Set up 4-hour interval check
    const FOUR_HOURS = 4 * 60 * 60 * 1000
    const intervalId = setInterval(checkForUpdates, FOUR_HOURS)

    return () => clearInterval(intervalId)
  }, [dispatch, autoCheckUpdate])

  useEffect(() => {
    if (proxyMode === 'system') {
      window.api.setProxy('system', undefined)
    } else if (proxyMode === 'custom') {
      proxyUrl && window.api.setProxy(proxyUrl, proxyBypassRules)
    } else {
      // set proxy to none for direct mode
      window.api.setProxy('', undefined)
    }
  }, [proxyUrl, proxyMode, proxyBypassRules])

  useEffect(() => {
    const currentLanguage = language || navigator.language || defaultLanguage
    i18n.changeLanguage(currentLanguage)
    setDayjsLocale(currentLanguage)
  }, [language])

  useEffect(() => {
    const isMacTransparentWindow = windowStyle === 'transparent' && isMac

    if (minappShow && isLeftNavbar) {
      window.root.style.background = isMacTransparentWindow ? 'var(--color-background)' : 'var(--navbar-background)'
      return
    }

    window.root.style.background = isMacTransparentWindow ? 'var(--navbar-background-mac)' : 'var(--navbar-background)'
  }, [windowStyle, minappShow, theme, isLeftNavbar])

  useEffect(() => {
    if (isLocalAi) {
      const model = JSON.parse(import.meta.env.VITE_RENDERER_INTEGRATED_MODEL)
      setDefaultModel(model)
      setQuickModel(model)
      setTranslateModel(model)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // set files path
    window.api.getAppInfo().then((info) => {
      dispatch(setFilesPath(info.filesPath))
      dispatch(setResourcesPath(info.resourcesPath))
    })
  }, [dispatch])

  useEffect(() => {
    KnowledgeQueue.checkAllBases()
  }, [])

  useEffect(() => {
    let customCssElement = document.getElementById('user-defined-custom-css') as HTMLStyleElement
    if (customCssElement) {
      customCssElement.remove()
    }

    if (customCss) {
      customCssElement = document.createElement('style')
      customCssElement.id = 'user-defined-custom-css'
      customCssElement.textContent = customCss
      document.head.appendChild(customCssElement)
    }
  }, [customCss])

  useEffect(() => {
    if (!window.electron?.ipcRenderer) return

    const requestListener = async (_event: Electron.IpcRendererEvent, payload: ToolPermissionRequestPayload) => {
      logger.debug('Renderer received tool permission request', {
        requestId: payload.requestId,
        toolName: payload.toolName,
        suggestionCount: payload.suggestions.length,
        autoApprove: payload.autoApprove
      })

      if (payload.autoApprove) {
        logger.debug('Auto-approving tool permission request', {
          requestId: payload.requestId,
          toolName: payload.toolName
        })

        try {
          const response = await window.api.agentTools.respondToPermission({
            requestId: payload.requestId,
            behavior: 'allow',
            updatedInput: payload.input,
            updatedPermissions: payload.suggestions
          })

          if (!response?.success) {
            throw new Error('Auto-approval response rejected by main process')
          }

          logger.debug('Auto-approval acknowledged by main process', {
            requestId: payload.requestId,
            toolName: payload.toolName
          })
        } catch (error) {
          logger.error('Failed to send auto-approval response', error as Error)
          // Fall through to add to store for manual approval
          dispatch(toolPermissionsActions.requestReceived(payload))
        }
        return
      }

      dispatch(toolPermissionsActions.requestReceived(payload))

      // Send system notification for agent tool approval
      sendToolApprovalNotification(payload.toolName)
    }

    const resultListener = (_event: Electron.IpcRendererEvent, payload: ToolPermissionResultPayload) => {
      logger.debug('Renderer received tool permission result', {
        requestId: payload.requestId,
        behavior: payload.behavior,
        reason: payload.reason
      })
      dispatch(toolPermissionsActions.requestResolved(payload))

      if (payload.behavior === 'deny') {
        const message =
          payload.reason === 'timeout'
            ? (payload.message ?? t('agent.toolPermission.toast.timeout'))
            : (payload.message ?? t('agent.toolPermission.toast.denied'))

        if (payload.reason === 'no-window') {
          logger.debug('Displaying deny toast for tool permission', {
            requestId: payload.requestId,
            behavior: payload.behavior,
            reason: payload.reason
          })
          window.toast?.error?.(message)
        } else if (payload.reason === 'timeout') {
          logger.debug('Displaying timeout toast for tool permission', {
            requestId: payload.requestId
          })
          window.toast?.warning?.(message)
        } else {
          logger.debug('Displaying info toast for tool permission deny', {
            requestId: payload.requestId,
            reason: payload.reason
          })
          window.toast?.info?.(message)
        }
      }
    }

    const removeListeners = [
      window.electron.ipcRenderer.on(IpcChannel.AgentToolPermission_Request, requestListener),
      window.electron.ipcRenderer.on(IpcChannel.AgentToolPermission_Result, resultListener)
    ]

    return () => removeListeners.forEach((removeListener) => removeListener())
  }, [dispatch, t])

  useEffect(() => {
    // TODO: init data collection
  }, [enableDataCollection])

  // Update memory service configuration when it changes
  useEffect(() => {
    const memoryService = MemoryService.getInstance()
    memoryService.updateConfig().catch((error) => logger.error('Failed to update memory config:', error))
  }, [memoryConfig])

  useEffect(() => {
    checkDataLimit()
  }, [])
}
