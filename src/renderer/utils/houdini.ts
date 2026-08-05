/**
 * Houdini 环境检测和适配工具
 */
import { loggerService } from '@logger'

const logger = loggerService.withContext('Utils:houdini')

// 检测是否在 Houdini 环境中运行
export const isHoudini = (): boolean => {
  // 检查是否存在 Houdini 特有的对象
  return (
    !!(window as any).hostBridge ||
    !!(window as any).houdini ||
    navigator.userAgent.includes('Houdini') ||
    // 检查是否在 QWebEngineView 中运行
    !!(window as any).qt ||
    !!(window as any).QWebChannel
  )
}

// 检测是否在 Electron 环境中运行
export const isElectron = (): boolean => {
  return !!(window as any).electron && !isHoudini()
}

// 检测是否在 Web 环境中运行
export const isWeb = (): boolean => {
  return !isElectron() && !isHoudini()
}

// 获取当前环境类型
export const getEnvironment = (): 'electron' | 'houdini' | 'web' => {
  if (isElectron()) return 'electron'
  if (isHoudini()) return 'houdini'
  return 'web'
}

// 安全地访问 window.electron，在 Houdini 环境中返回模拟对象
export const getElectronAPI = () => {
  if (isElectron()) {
    return (window as any).electron
  }

  // 在 Houdini 环境中返回模拟的 Electron API
  return {
    ipcRenderer: {
      invoke: async (channel: string, ...args: any[]) => {
        logger.debug(`[Houdini Mock] IPC invoke: ${channel}`, { args })
        // 返回基本的模拟响应
        switch (channel) {
          case 'app:info':
            return { version: '1.0.0', platform: 'win32', arch: 'x64' }
          case 'app:get-cache-size':
            return { size: 0, count: 0 }
          case 'app:is-full-screen':
            return false
          default:
            return null
        }
      },
      send: (channel: string, ...args: any[]) => {
        logger.debug(`[Houdini Mock] IPC send: ${channel}`, { args })
      },
      on: (channel: string, _callback: Function) => {
        logger.debug(`[Houdini Mock] IPC on: ${channel}`)
        return () => {} // 返回清理函数
      },
      removeListener: (channel: string, _callback: Function) => {
        logger.debug(`[Houdini Mock] IPC removeListener: ${channel}`)
      },
      removeAllListeners: (channel: string) => {
        logger.debug(`[Houdini Mock] IPC removeAllListeners: ${channel}`)
      }
    },
    process: {
      platform: 'win32',
      arch: 'x64',
      env: {
        NODE_ENV: 'production'
      }
    }
  }
}

// 安全地访问 window.api，在 Houdini 环境中返回模拟对象
export const getApi = () => {
  if (isElectron()) {
    return (window as any).api
  }

  // 在 Houdini 环境中返回模拟的 API
  return {
    storeSync: {
      onUpdate: (syncAction: any) => {
        logger.debug('[Houdini Mock] storeSync.onUpdate', { syncAction })
      },
      subscribe: () => {
        logger.debug('[Houdini Mock] storeSync.subscribe')
      },
      unsubscribe: () => {
        logger.debug('[Houdini Mock] storeSync.unsubscribe')
      }
    },
    getDiskInfo: async (path: string) => {
      logger.debug('[Houdini Mock] getDiskInfo', { path })
      return { total: 1000000000, free: 500000000 }
    },
    getAppInfo: async () => {
      logger.debug('[Houdini Mock] getAppInfo')
      return { version: '1.0.0', platform: 'win32', arch: 'x64' }
    },
    file: {
      isTextFile: async (filePath: string) => {
        logger.debug('[Houdini Mock] file.isTextFile', { filePath })
        return filePath.endsWith('.txt') || filePath.endsWith('.md')
      },
      select: async (options: any) => {
        logger.debug('[Houdini Mock] file.select', { options })
        return []
      },
      binaryImage: async (fileId: string) => {
        logger.debug('[Houdini Mock] file.binaryImage', { fileId })
        return null
      }
    },
    logToMain: (source: string, level: string, message: string, data?: any) => {
      logger.debug(`[Houdini Mock] logToMain [${level}] ${source}`, { message, data })
    },
    selection: {
      setEnabled: (enabled: boolean) => {
        logger.debug('[Houdini Mock] selection.setEnabled', { enabled })
      },
      setTriggerMode: (mode: string) => {
        logger.debug('[Houdini Mock] selection.setTriggerMode', { mode })
      },
      setFollowToolbar: (isFollowToolbar: boolean) => {
        logger.debug('[Houdini Mock] selection.setFollowToolbar', { isFollowToolbar })
      },
      setRemeberWinSize: (isRemeberWinSize: boolean) => {
        logger.debug('[Houdini Mock] selection.setRemeberWinSize', { isRemeberWinSize })
      },
      setFilterMode: (mode: string) => {
        logger.debug('[Houdini Mock] selection.setFilterMode', { mode })
      },
      setFilterList: (list: any[]) => {
        logger.debug('[Houdini Mock] selection.setFilterList', { list })
      }
    }
  }
}
