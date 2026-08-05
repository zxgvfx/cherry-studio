import { electronAPI } from '@electron-toolkit/preload'
import type { DataApiDataChangeEffect } from '@shared/data/api/types'
import type { CacheEntry, CacheSyncMessage } from '@shared/data/cache/cacheTypes'
import type {
  UnifiedPreferenceKeyType,
  UnifiedPreferenceMultipleResultType,
  UnifiedPreferenceType
} from '@shared/data/preference/preferenceTypes'
import type { FileEntry, FileHandle } from '@shared/data/types/file'
import type { FileMetadata } from '@shared/data/types/legacyFile'
import { IpcChannel } from '@shared/IpcChannel'
import type { BackupResult, LocalBackupConfig, S3Config, WebDavConfig } from '@shared/types/backup'
import type { MenuAnchor, NativePopupMenuModel, NativePopupMenuResult } from '@shared/types/command'
import type { ExternalAppInfo } from '@shared/types/externalApp'
import type {
  AbsoluteFilePath,
  CreateInternalEntryIpcParams,
  EnsureExternalEntryIpcParams,
  GetPhysicalPathIpcParams
} from '@shared/types/file'
import type {
  LanClientEvent,
  LanFileCompleteMessage,
  LanHandshakeAckMessage,
  LanTransferConnectPayload,
  LanTransferState
} from '@shared/types/lanTransfer'
import type { ShortcutPreferenceKey } from '@shared/types/shortcut'
import type { SkillFileNode, SkillResult } from '@shared/types/skill'
import type { StorageHealth } from '@shared/types/storageMonitor'
import type { CommandId } from '@shared/utils/command'
import type { CreateTreeIpcResult, DirectoryTreeOptions, TreeMutationPushPayload } from '@shared/utils/file'
import type { OpenDialogOptions } from 'electron'
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import type { CreateDirectoryOptions } from 'webdav'

import { ipcApi } from './ipc'

type DirectoryListOptions = {
  recursive?: boolean
  maxDepth?: number
  includeHidden?: boolean
  includeFiles?: boolean
  includeDirectories?: boolean
  maxEntries?: number
  searchPattern?: string
}

type DirectoryEntry = {
  path: string
  isDirectory: boolean
}

type ShortcutRegistrationConflictPayload = {
  key: ShortcutPreferenceKey
  accelerator?: string
  hasConflict: boolean
}

// Custom APIs for renderer
const api = {
  setSpellCheckLanguages: (languages: string[]) => ipcRenderer.invoke(IpcChannel.App_SetSpellCheckLanguages, languages),
  setLaunchOnBoot: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetLaunchOnBoot, isActive),
  select: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke(IpcChannel.App_Select, options),
  hasWritePermission: (path: string) => ipcRenderer.invoke(IpcChannel.App_HasWritePermission, path),
  resolvePath: (path: string) => ipcRenderer.invoke(IpcChannel.App_ResolvePath, path),
  isPathInside: (childPath: string, parentPath: string) =>
    ipcRenderer.invoke(IpcChannel.App_IsPathInside, childPath, parentPath),
  application: {
    preventQuit: (reason: string): Promise<string> => ipcRenderer.invoke(IpcChannel.Application_PreventQuit, reason),
    allowQuit: (holdId: string): Promise<void> => ipcRenderer.invoke(IpcChannel.Application_AllowQuit, holdId),
    relaunch: (options?: Electron.RelaunchOptions): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.Application_Relaunch, options)
  },
  getCacheSize: () => ipcRenderer.invoke(IpcChannel.App_GetCacheSize),
  clearCache: () => ipcRenderer.invoke(IpcChannel.App_ClearCache),
  system: {
    getHostname: () => ipcRenderer.invoke(IpcChannel.System_GetHostname)
    // Git Bash is resolved in the main process (settingsBuilder); no renderer API.
  },
  zip: {
    decompress: (text: Buffer) => ipcRenderer.invoke(IpcChannel.Zip_Decompress, text)
  },
  backup: {
    restore: (path: string) => ipcRenderer.invoke(IpcChannel.Backup_Restore, path),
    // Direct backup methods (copy IndexedDB/LocalStorage directories directly)
    backup: (fileName: string, destinationPath: string, skipBackupFile?: boolean) =>
      ipcRenderer.invoke(IpcChannel.Backup_Backup, fileName, destinationPath, skipBackupFile),
    backupToWebdav: (webdavConfig: WebDavConfig): Promise<BackupResult<boolean>> =>
      ipcRenderer.invoke(IpcChannel.Backup_BackupToWebdav, webdavConfig),
    restoreFromWebdav: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_RestoreFromWebdav, webdavConfig),
    listWebdavFiles: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_ListWebdavFiles, webdavConfig),
    checkConnection: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_CheckConnection, webdavConfig),
    createDirectory: (webdavConfig: WebDavConfig, path: string, options?: CreateDirectoryOptions) =>
      ipcRenderer.invoke(IpcChannel.Backup_CreateDirectory, webdavConfig, path, options),
    deleteWebdavFile: (fileName: string, webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_DeleteWebdavFile, fileName, webdavConfig),
    backupToLocalDir: (fileName: string | undefined, localConfig: LocalBackupConfig): Promise<BackupResult<string>> =>
      ipcRenderer.invoke(IpcChannel.Backup_BackupToLocalDir, fileName, localConfig),
    restoreFromLocalBackup: (fileName: string, localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_RestoreFromLocalBackup, fileName, localBackupDir),
    listLocalBackupFiles: (localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_ListLocalBackupFiles, localBackupDir),
    deleteLocalBackupFile: (fileName: string, localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_DeleteLocalBackupFile, fileName, localBackupDir),
    checkWebdavConnection: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_CheckConnection, webdavConfig),
    backupToS3: (s3Config: S3Config): Promise<BackupResult<unknown>> =>
      ipcRenderer.invoke(IpcChannel.Backup_BackupToS3, s3Config),
    restoreFromS3: (s3Config: S3Config) => ipcRenderer.invoke(IpcChannel.Backup_RestoreFromS3, s3Config),
    listS3Files: (s3Config: S3Config) => ipcRenderer.invoke(IpcChannel.Backup_ListS3Files, s3Config),
    deleteS3File: (fileName: string, s3Config: S3Config) =>
      ipcRenderer.invoke(IpcChannel.Backup_DeleteS3File, fileName, s3Config),
    createLanTransferBackup: (data: string, destinationPath?: string): Promise<string> =>
      ipcRenderer.invoke(IpcChannel.Backup_CreateLanTransferBackup, data, destinationPath),
    deleteLanTransferBackup: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.Backup_DeleteLanTransferBackup, filePath)
  },
  file: {
    select: (options?: OpenDialogOptions): Promise<FileMetadata[] | null> =>
      ipcRenderer.invoke(IpcChannel.File_Select, options),
    createInternalEntry: (params: CreateInternalEntryIpcParams): Promise<FileEntry> =>
      ipcRenderer.invoke(IpcChannel.File_CreateInternalEntry, params),
    ensureExternalEntry: (params: EnsureExternalEntryIpcParams): Promise<FileEntry> =>
      ipcRenderer.invoke(IpcChannel.File_EnsureExternalEntry, params),
    getPhysicalPath: (params: GetPhysicalPathIpcParams): Promise<AbsoluteFilePath> =>
      ipcRenderer.invoke(IpcChannel.File_GetPhysicalPath, params),
    permanentDelete: (handle: FileHandle): Promise<void> => ipcRenderer.invoke(IpcChannel.File_PermanentDelete, handle),
    runSweep: () => ipcRenderer.invoke(IpcChannel.File_RunSweep),
    deleteExternalFile: (filePath: string) => ipcRenderer.invoke(IpcChannel.File_DeleteExternalFile, filePath),
    deleteExternalDir: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_DeleteExternalDir, dirPath),
    move: (path: string, newPath: string) => ipcRenderer.invoke(IpcChannel.File_Move, path, newPath),
    moveDir: (dirPath: string, newDirPath: string) => ipcRenderer.invoke(IpcChannel.File_MoveDir, dirPath, newDirPath),
    rename: (path: string, newName: string) => ipcRenderer.invoke(IpcChannel.File_Rename, path, newName),
    renameDir: (dirPath: string, newName: string) => ipcRenderer.invoke(IpcChannel.File_RenameDir, dirPath, newName),
    readExternal: (filePath: string, detectEncoding?: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_ReadExternal, filePath, detectEncoding),
    get: (filePath: string): Promise<FileMetadata | null> => ipcRenderer.invoke(IpcChannel.File_Get, filePath),
    createTempFile: (fileName: string): Promise<string> => ipcRenderer.invoke(IpcChannel.File_CreateTempFile, fileName),
    mkdir: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_Mkdir, dirPath),
    write: (filePath: string, data: Uint8Array | string) => ipcRenderer.invoke(IpcChannel.File_Write, filePath, data),
    open: (options?: OpenDialogOptions) => ipcRenderer.invoke(IpcChannel.File_Open, options),
    openPath: (path: string) => ipcRenderer.invoke(IpcChannel.File_OpenPath, path),
    save: (path: string, content: string | NodeJS.ArrayBufferView, options?: any): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannel.File_Save, path, content, options),
    selectFolder: (options?: OpenDialogOptions): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannel.File_SelectFolder, options),
    saveImage: (name: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.File_SaveImage, name, data),
    binaryImage: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_BinaryImage, fileId),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    listDirectory: (dirPath: string, options?: DirectoryListOptions) =>
      ipcRenderer.invoke(IpcChannel.File_ListDirectory, dirPath, options),
    listDirectoryEntries: (dirPath: string, options?: DirectoryListOptions): Promise<DirectoryEntry[]> =>
      ipcRenderer.invoke(IpcChannel.File_ListDirectoryEntries, dirPath, options),
    checkFileName: (dirPath: string, fileName: string, isFile: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_CheckFileName, dirPath, fileName, isFile),
    validateNotesDirectory: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_ValidateNotesDirectory, dirPath),
    // Legacy file-watcher bindings (`startFileWatcher` / `stopFileWatcher`
    // / `pauseFileWatcher` / `resumeFileWatcher` / `onFileChange`) and
    // `getDirectoryStructure` were removed alongside the Notes migration
    // to `DirectoryTreeBuilder` (see docs/references/file/directory-tree.md).
    // mutations via `window.api.tree.onMutation` instead.
    batchUploadMarkdown: (filePaths: string[], targetPath: string) =>
      ipcRenderer.invoke(IpcChannel.File_BatchUploadMarkdown, filePaths, targetPath),
    showInFolder: (path: string): Promise<void> => ipcRenderer.invoke(IpcChannel.File_ShowInFolder, path)
  },
  fs: {
    read: (pathOrUrl: string, encoding?: BufferEncoding) => ipcRenderer.invoke(IpcChannel.Fs_Read, pathOrUrl, encoding),
    readText: (pathOrUrl: string): Promise<string> => ipcRenderer.invoke(IpcChannel.Fs_ReadText, pathOrUrl)
  },
  tree: {
    create: (rootPath: string, options?: DirectoryTreeOptions): Promise<CreateTreeIpcResult> =>
      ipcRenderer.invoke(IpcChannel.File_TreeCreate, { rootPath, options }),
    dispose: (treeId: string): Promise<void> => ipcRenderer.invoke(IpcChannel.File_TreeDispose, { treeId }),
    rename: (treeId: string, oldPath: string, newPath: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.File_TreeRename, { treeId, oldPath, newPath }),
    onMutation: (callback: (payload: TreeMutationPushPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TreeMutationPushPayload) => {
        if (payload && typeof payload === 'object') callback(payload)
      }
      ipcRenderer.on(IpcChannel.File_TreeMutation, listener)
      return () => ipcRenderer.off(IpcChannel.File_TreeMutation, listener)
    }
  },
  command: {
    showNativePopupMenu: (
      model: NativePopupMenuModel<CommandId>,
      anchor?: MenuAnchor
    ): Promise<NativePopupMenuResult<CommandId> | undefined> =>
      ipcRenderer.invoke(IpcChannel.NativeCommandPopupMenu_Show, model, anchor)
  },
  aes: {
    decrypt: (encryptedData: string, iv: string, secretKey: string) =>
      ipcRenderer.invoke(IpcChannel.Aes_Decrypt, encryptedData, iv, secretKey)
  },
  shell: {
    openExternal: (url: string, options?: Electron.OpenExternalOptions) => {
      // Defense-in-depth: validate URL scheme before forwarding to shell.openExternal
      const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:', 'obsidian:']
      try {
        const parsed = new URL(url)
        if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
          return Promise.reject(new Error(`Blocked openExternal for untrusted URL scheme: ${parsed.protocol}`))
        }
      } catch {
        return Promise.reject(new Error('Blocked openExternal for invalid URL'))
      }
      return shell.openExternal(url, options)
    }
  },
  copilot: {
    getAuthMessage: (headers?: Record<string, string>) =>
      ipcRenderer.invoke(IpcChannel.Copilot_GetAuthMessage, headers),
    getCopilotToken: (device_code: string, headers?: Record<string, string>) =>
      ipcRenderer.invoke(IpcChannel.Copilot_GetCopilotToken, device_code, headers),
    saveCopilotToken: (access_token: string) => ipcRenderer.invoke(IpcChannel.Copilot_SaveCopilotToken, access_token),
    getToken: (headers?: Record<string, string>) => ipcRenderer.invoke(IpcChannel.Copilot_GetToken, headers),
    logout: () => ipcRenderer.invoke(IpcChannel.Copilot_Logout),
    getUser: (token: string) => ipcRenderer.invoke(IpcChannel.Copilot_GetUser, token)
  },
  // CherryIN OAuth + Codex / Grok CLI OAuth migrated to IpcApi — see
  // `ipcApi.request('oauth.*' | 'cherryin.*')` and `ipcApi.on('oauth.deep_link_result')`.
  // BinaryManager tool manager was migrated to IpcApi — see `window.api.ipcApi` / `ipcApi.request('binary.*')`.
  externalApps: {
    detectInstalled: (): Promise<ExternalAppInfo[]> => ipcRenderer.invoke(IpcChannel.ExternalApps_DetectInstalled)
  },
  nutstore: {
    getSSOUrl: () => ipcRenderer.invoke(IpcChannel.Nutstore_GetSsoUrl),
    decryptToken: (token: string) => ipcRenderer.invoke(IpcChannel.Nutstore_DecryptToken, token),
    getDirectoryContents: (token: string, path: string) =>
      ipcRenderer.invoke(IpcChannel.Nutstore_GetDirectoryContents, token, path)
  },
  quoteToMainWindow: (text: string) => ipcRenderer.invoke(IpcChannel.App_QuoteToMain, text),
  // setDisableHardwareAcceleration: (isDisable: boolean) =>
  //   ipcRenderer.invoke(IpcChannel.App_SetDisableHardwareAcceleration, isDisable),
  // setUseSystemTitleBar: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetUseSystemTitleBar, isActive),
  trace: {
    getData: (topicId: string, traceId: string) => ipcRenderer.invoke(IpcChannel.TRACE_GET_DATA, topicId, traceId),
    cleanLocalData: () => ipcRenderer.invoke(IpcChannel.TRACE_CLEAN_LOCAL_DATA)
  },
  shortcut: {
    onRegistrationConflict: (callback: (payload: ShortcutRegistrationConflictPayload) => void): (() => void) => {
      const channel = IpcChannel.Shortcut_RegistrationConflict
      const listener = (_: Electron.IpcRendererEvent, payload: ShortcutRegistrationConflictPayload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    }
  },
  // CacheService related APIs
  cache: {
    // Broadcast sync message to other windows
    broadcastSync: (message: CacheSyncMessage): void => ipcRenderer.send(IpcChannel.Cache_Sync, message),

    // Listen for sync messages from other windows
    onSync: (callback: (message: CacheSyncMessage) => void) => {
      const listener = (_: any, message: CacheSyncMessage) => callback(message)
      ipcRenderer.on(IpcChannel.Cache_Sync, listener)
      return () => ipcRenderer.off(IpcChannel.Cache_Sync, listener)
    },

    // Get all shared cache entries from Main for initialization sync
    getAllShared: (): Promise<Record<string, CacheEntry>> => ipcRenderer.invoke(IpcChannel.Cache_GetAllShared)
  },

  // StorageMonitorService related APIs (main-process disk-space watcher)
  storageMonitor: {
    // Pull the current disk-space health to seed initial state on mount
    getHealth: (): Promise<StorageHealth> => ipcRenderer.invoke(IpcChannel.StorageMonitor_GetHealth),

    // Subscribe to health transitions (ok <-> low) pushed from Main
    onHealthChange: (callback: (health: StorageHealth) => void) => {
      const listener = (_: any, health: StorageHealth) => callback(health)
      ipcRenderer.on(IpcChannel.StorageMonitor_HealthChanged, listener)
      return () => ipcRenderer.off(IpcChannel.StorageMonitor_HealthChanged, listener)
    }
  },

  // PreferenceService related APIs
  // DO NOT MODIFY THIS SECTION
  preference: {
    get: <K extends UnifiedPreferenceKeyType>(key: K): Promise<UnifiedPreferenceType[K]> =>
      ipcRenderer.invoke(IpcChannel.Preference_Get, key),
    set: <K extends UnifiedPreferenceKeyType>(key: K, value: UnifiedPreferenceType[K]): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.Preference_Set, key, value),
    getMultipleRaw: <K extends UnifiedPreferenceKeyType>(keys: K[]): Promise<UnifiedPreferenceMultipleResultType<K>> =>
      ipcRenderer.invoke(IpcChannel.Preference_GetMultipleRaw, keys),
    setMultiple: (updates: Partial<UnifiedPreferenceType>) =>
      ipcRenderer.invoke(IpcChannel.Preference_SetMultiple, updates),
    getAll: (): Promise<UnifiedPreferenceType> => ipcRenderer.invoke(IpcChannel.Preference_GetAll),
    subscribe: (keys: UnifiedPreferenceKeyType[]) => ipcRenderer.invoke(IpcChannel.Preference_Subscribe, keys),
    onChanged: (callback: (key: UnifiedPreferenceKeyType, value: any) => void) => {
      const listener = (_: any, key: UnifiedPreferenceKeyType, value: any) => callback(key, value)
      ipcRenderer.on(IpcChannel.Preference_Changed, listener)
      return () => ipcRenderer.off(IpcChannel.Preference_Changed, listener)
    }
  },
  // Data API related APIs
  dataApi: {
    request: (req: any) => ipcRenderer.invoke(IpcChannel.DataApi_Request, req),
    // DataApi data change notifications: single fixed channel, main → all windows.
    onDataChanged: (callback: (effects: DataApiDataChangeEffect[]) => void) => {
      const listener = (_: any, effects: DataApiDataChangeEffect[]) => callback(effects)
      ipcRenderer.on(IpcChannel.DataApi_DataChanged, listener)
      return () => ipcRenderer.off(IpcChannel.DataApi_DataChanged, listener)
    }
  },
  // IpcApi RPC channel — generic forwarder; the typed facade lives in src/renderer/ipc
  ipcApi,
  // All `ai.*` / `translate.*` capability IPC moved to IpcApi (`ipcApi.request(...)` /
  // `ipcApi.on('ai.stream_*')`): model ops, streaming chat + translate, agent-session
  // warm-up, tool approval, agent run-task, and the topic/agent-session auto-rename events.
  skill: {
    readSkillFile: (skillId: string, filename: string): Promise<SkillResult<string | null>> =>
      ipcRenderer.invoke(IpcChannel.Skill_ReadFile, skillId, filename),
    listFiles: (skillId: string): Promise<SkillResult<SkillFileNode[]>> =>
      ipcRenderer.invoke(IpcChannel.Skill_ListFiles, skillId)
  },
  lanTransfer: {
    startScan: (): Promise<LanTransferState> => ipcRenderer.invoke(IpcChannel.LanTransfer_StartScan),
    stopScan: (): Promise<LanTransferState> => ipcRenderer.invoke(IpcChannel.LanTransfer_StopScan),
    connect: (payload: LanTransferConnectPayload): Promise<LanHandshakeAckMessage> =>
      ipcRenderer.invoke(IpcChannel.LanTransfer_Connect, payload),
    disconnect: (): Promise<void> => ipcRenderer.invoke(IpcChannel.LanTransfer_Disconnect),
    onServicesUpdated: (callback: (state: LanTransferState) => void): (() => void) => {
      const channel = IpcChannel.LanTransfer_ServicesUpdated
      const listener = (_: Electron.IpcRendererEvent, state: LanTransferState) => callback(state)
      ipcRenderer.on(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    },
    onClientEvent: (callback: (event: LanClientEvent) => void): (() => void) => {
      const channel = IpcChannel.LanTransfer_ClientEvent
      const listener = (_: Electron.IpcRendererEvent, event: LanClientEvent) => callback(event)
      ipcRenderer.on(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    },
    sendFile: (filePath: string): Promise<LanFileCompleteMessage> =>
      ipcRenderer.invoke(IpcChannel.LanTransfer_SendFile, { filePath }),
    cancelTransfer: (): Promise<void> => ipcRenderer.invoke(IpcChannel.LanTransfer_CancelTransfer)
  }
}

// ============================================================================
// Houdini / Qt WebEngineView 环境适配
//
// 注意：这份 preload 脚本在真实的桌面 Electron 应用里由 Electron 自身以
// Node context 加载执行；但 Houdini 插件用的是裸的 QWebEngineView（不是
// Electron），既没有 Node 环境也无法 `require('electron')`，所以这个文件
// 实际上不会在 Houdini 运行时里被加载 —— 真正生效的 `window.api` /
// `window.electron` 桥接完全由 `cherrystudio/web/electron_injector.py`
// 在页面加载时用 Python 拼出等价的 JS 字符串注入实现（见该文件里的
// `window.api = {{...}}`）。
//
// 这里保留一份同构的兜底实现，仅用于以下场景：
// 1）在普通浏览器标签页里直接打开构建产物做快速预览/调试；
// 2）未来如果 Houdini 侧改为真正加载这份构建出的 preload bundle（例如通过
//    某种 Node 桥接），也能有一层安全、不阻塞的默认实现。
// 生产环境下应始终以 `electron_injector.py` 注入的实现为准。
// ============================================================================

function isHoudiniEnvironment(): boolean {
  const hasQt = !!(window as any).qt
  const hasQWebChannel = !!(window as any).QWebChannel
  const hasHoudiniUserAgent = navigator.userAgent.includes('Houdini')
  const hasHoudiniFlag = !!(window as any).houdini
  const hasHostBridge = !!(window as any).hostBridge

  // 如果不在真正的 Electron 环境中，就认为是 Houdini / 纯浏览器环境
  const isNotElectron = !(window as any).electron && !process.versions?.electron

  return hasQt || hasQWebChannel || hasHoudiniUserAgent || hasHoudiniFlag || hasHostBridge || isNotElectron
}

function createHoudiniElectronAPI() {
  return {
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => {
        console.log(`[Houdini] IPC send: ${channel}`, args)
      },
      sendTo: (webContentsId: number, channel: string, ...args: any[]) => {
        console.log(`[Houdini] IPC sendTo: ${webContentsId} ${channel}`, args)
      },
      sendSync: (channel: string, ...args: any[]) => {
        console.log(`[Houdini] IPC sendSync: ${channel}`, args)
        return null
      },
      sendToHost: (channel: string, ...args: any[]) => {
        console.log(`[Houdini] IPC sendToHost: ${channel}`, args)
      },
      postMessage: (channel: string, message: any, _transfer?: any[]) => {
        console.log(`[Houdini] IPC postMessage: ${channel}`, message)
      },
      invoke: async (channel: string, ...args: any[]) => {
        console.log(`[Houdini] IPC invoke: ${channel}`, args)
        if (channel === 'app:info') return { version: '1.0.0', platform: 'win32', arch: 'x64' }
        if (channel === 'app:get-cache-size') return '0'
        if (channel === 'app:is-full-screen') return false
        return null
      },
      on: (channel: string, _listener: (...args: any[]) => void) => {
        console.log(`[Houdini] IPC on: ${channel}`)
        return () => {
          console.log(`[Houdini] IPC removeListener: ${channel}`)
        }
      },
      removeListener: (channel: string, _listener: (...args: any[]) => void) => {
        console.log(`[Houdini] IPC removeListener: ${channel}`)
      },
      removeAllListeners: (channel: string) => {
        console.log(`[Houdini] IPC removeAllListeners: ${channel}`)
      }
    },
    process: {
      platform: 'win32',
      versions: { node: '18.0.0', chrome: '100.0.0', electron: '20.0.0' }
    }
  }
}

// 极简的 localStorage 兜底偏好设置存储。真实的 Houdini 运行时里，这个命名
// 空间应由 `electron_injector.py` 覆盖为连接 Python 侧集中配置的实现；这里
// 只是为了避免 `window.api.preference` 整体缺失导致渲染进程崩溃。
function createHoudiniPreferenceApi() {
  const STORAGE_KEY = '__houdini_preferences__'

  function readAll(): Record<string, any> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }

  function writeAll(data: Record<string, any>): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // localStorage 不可用（例如隐私模式）时静默忽略
    }
  }

  return {
    get: async (key: string) => readAll()[key],
    set: async (key: string, value: any) => {
      const all = readAll()
      all[key] = value
      writeAll(all)
    },
    getMultipleRaw: async (keys: string[]) => {
      const all = readAll()
      const result: Record<string, any> = {}
      for (const key of keys) result[key] = all[key]
      return result
    },
    setMultiple: async (updates: Record<string, any>) => {
      const all = readAll()
      Object.assign(all, updates)
      writeAll(all)
    },
    getAll: async () => readAll(),
    subscribe: async (_keys: string[]) => undefined,
    onChanged: (_callback: (key: string, value: any) => void): (() => void) => {
      return () => {}
    }
  }
}

// `ipcApi` / `dataApi` 是 v2.0 里几乎所有能力（AI 流式对话、翻译、Agent 会话、
// OAuth、Skills 市场、通用数据读写……）汇聚的两条统一泛型通道。真正的 Houdini
// 桥接应该在这里把 `route`/`input` 转发给 Qt 侧的等价服务（例如
// `window.qt.api.ipcApiRequest` / `dataApiRequest`），但那部分后端尚未实现，
// 因此这里先返回明确的"未实现"错误，而不是让渲染进程无限期挂起等待一个永远
// 不会到来的响应。
function createHoudiniGenericRequestApi(label: 'ipcApi' | 'dataApi', bridgeKey: string) {
  return {
    request: async (route: string, input?: unknown, meta?: unknown): Promise<unknown> => {
      const bridge = (window as any).qt?.api?.[bridgeKey]
      if (bridge) {
        const raw = await bridge(JSON.stringify({ route, input, meta }))
        const data = typeof raw === 'string' && raw ? JSON.parse(raw) : raw
        if (data && typeof data === 'object' && 'error' in data && data.error) {
          const msg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error)
          throw new Error(msg)
        }
        return data
      }
      console.warn(`[Houdini] ${label}.request('${route}') has no Qt bridge yet`, input)
      throw new Error(`Houdini runtime: ${label} route "${route}" is not implemented yet.`)
    },
    on: (_event: string, _callback: (payload: unknown) => void): (() => void) => {
      return () => {}
    }
  }
}

// Skills 走 Node agent-runtime sidecar 的 `/v1/skills` REST 接口（通过
// `window.qt.api.agentApiProxy` 转发）；真正的 Houdini/Qt 运行时里
// `electron_injector.py` 会覆盖这里为等价但更完整的实现。
function createHoudiniSkillApi() {
  async function proxyCall(method: string, path: string, body?: unknown): Promise<any> {
    const proxy = (window as any).qt?.api?.agentApiProxy
    if (!proxy) {
      throw new Error('Qt agent API bridge not available')
    }
    const raw: string = await proxy(JSON.stringify({ method, path, body: body ?? null }))
    let data: any
    try {
      data = typeof raw === 'string' && raw ? JSON.parse(raw) : raw
    } catch {
      data = raw
    }
    if (data && typeof data === 'object' && 'error' in data && data.error) {
      const msg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error)
      throw new Error(msg)
    }
    return data
  }

  return {
    readSkillFile: async (skillId: string, filename: string): Promise<SkillResult<string | null>> => {
      try {
        const encodedPath = filename.split('/').map(encodeURIComponent).join('/')
        const text = await proxyCall('GET', `/v1/skills/${encodeURIComponent(skillId)}/files/${encodedPath}`)
        return { success: true, data: typeof text === 'string' ? text : JSON.stringify(text) }
      } catch (error) {
        return { success: false, error }
      }
    },
    listFiles: async (skillId: string): Promise<SkillResult<SkillFileNode[]>> => {
      try {
        const result = await proxyCall('GET', `/v1/skills/${encodeURIComponent(skillId)}/files`)
        const nodes: SkillFileNode[] = (result?.data || []).map((relPath: string) => ({
          name: relPath.split('/').pop() || relPath,
          path: relPath,
          type: 'file' as const
        }))
        return { success: true, data: nodes }
      } catch (error) {
        return { success: false, error }
      }
    }
  }
}

function createHoudiniAPI() {
  const noopUnsubscribe = () => () => {}

  return {
    setSpellCheckLanguages: async (_languages: string[]) => undefined,
    setLaunchOnBoot: async (_isActive: boolean) => undefined,
    select: async (_options: Electron.OpenDialogOptions) => null,
    hasWritePermission: async (_path: string) => true,
    resolvePath: async (path: string) => path,
    isPathInside: async (_childPath: string, _parentPath: string) => false,
    application: {
      preventQuit: async (_reason: string) => 'houdini-noop',
      allowQuit: async (_holdId: string) => undefined,
      relaunch: async (_options?: Electron.RelaunchOptions) => undefined
    },
    getCacheSize: async () => '0',
    clearCache: async () => undefined,
    system: {
      getHostname: async () => 'houdini'
    },
    zip: {
      decompress: async (_text: Buffer) => Buffer.from('')
    },
    backup: {
      restore: async (_path: string) => undefined,
      backup: async (_fileName: string, _destinationPath: string, _skipBackupFile?: boolean) => undefined,
      backupToWebdav: async (_webdavConfig: WebDavConfig) => ({
        success: false,
        error: 'Not supported in Houdini runtime'
      }),
      restoreFromWebdav: async (_webdavConfig: WebDavConfig) => undefined,
      listWebdavFiles: async (_webdavConfig: WebDavConfig) => [],
      checkConnection: async (_webdavConfig: WebDavConfig) => false,
      createDirectory: async (_webdavConfig: WebDavConfig, _path: string, _options?: CreateDirectoryOptions) =>
        undefined,
      deleteWebdavFile: async (_fileName: string, _webdavConfig: WebDavConfig) => undefined,
      backupToLocalDir: async (_fileName: string | undefined, _localConfig: LocalBackupConfig) => '',
      restoreFromLocalBackup: async (_fileName: string, _localBackupDir?: string) => undefined,
      listLocalBackupFiles: async (_localBackupDir?: string) => [],
      deleteLocalBackupFile: async (_fileName: string, _localBackupDir?: string) => undefined,
      checkWebdavConnection: async (_webdavConfig: WebDavConfig) => false,
      backupToS3: async (_s3Config: S3Config) => ({ success: false, error: 'Not supported in Houdini runtime' }),
      restoreFromS3: async (_s3Config: S3Config) => undefined,
      listS3Files: async (_s3Config: S3Config) => [],
      deleteS3File: async (_fileName: string, _s3Config: S3Config) => undefined,
      createLanTransferBackup: async (_data: string, _destinationPath?: string) => '',
      deleteLanTransferBackup: async (_filePath: string) => false
    },
    file: {
      select: async (_options?: OpenDialogOptions): Promise<FileMetadata[] | null> => null,
      createInternalEntry: async (_params: CreateInternalEntryIpcParams) => {
        throw new Error('Not supported in Houdini runtime')
      },
      ensureExternalEntry: async (_params: EnsureExternalEntryIpcParams) => {
        throw new Error('Not supported in Houdini runtime')
      },
      getPhysicalPath: async (_params: GetPhysicalPathIpcParams) => {
        throw new Error('Not supported in Houdini runtime')
      },
      permanentDelete: async (_handle: FileHandle) => undefined,
      runSweep: async () => undefined,
      deleteExternalFile: async (_filePath: string) => undefined,
      deleteExternalDir: async (_dirPath: string) => undefined,
      move: async (_path: string, _newPath: string) => undefined,
      moveDir: async (_dirPath: string, _newDirPath: string) => undefined,
      rename: async (_path: string, _newName: string) => undefined,
      renameDir: async (_dirPath: string, _newName: string) => undefined,
      readExternal: async (_filePath: string, _detectEncoding?: boolean) => null,
      get: async (_filePath: string): Promise<FileMetadata | null> => null,
      createTempFile: async (fileName: string) => fileName,
      mkdir: async (_dirPath: string) => undefined,
      write: async (_filePath: string, _data: Uint8Array | string) => undefined,
      open: async (_options?: OpenDialogOptions) => null,
      openPath: async (_path: string) => undefined,
      save: async (_path: string, _content: string | NodeJS.ArrayBufferView, _options?: any) => null,
      selectFolder: async (_options?: OpenDialogOptions) => null,
      saveImage: async (_name: string, _data: string) => false,
      binaryImage: async (_fileId: string) => null,
      getPathForFile: (_file: File) => '',
      listDirectory: async (_dirPath: string, _options?: DirectoryListOptions) => [],
      listDirectoryEntries: async (_dirPath: string, _options?: DirectoryListOptions): Promise<DirectoryEntry[]> => [],
      checkFileName: async (_dirPath: string, _fileName: string, _isFile: boolean) => true,
      validateNotesDirectory: async (_dirPath: string) => true,
      batchUploadMarkdown: async (_filePaths: string[], _targetPath: string) => undefined,
      showInFolder: async (_path: string) => undefined
    },
    fs: {
      read: async (_pathOrUrl: string, _encoding?: BufferEncoding) => null,
      readText: async (_pathOrUrl: string) => ''
    },
    tree: {
      create: async (_rootPath: string, _options?: DirectoryTreeOptions) => {
        throw new Error('Not supported in Houdini runtime')
      },
      dispose: async (_treeId: string) => undefined,
      rename: async (_treeId: string, _oldPath: string, _newPath: string) => false,
      onMutation: (_callback: (payload: TreeMutationPushPayload) => void) => noopUnsubscribe()
    },
    command: {
      showNativePopupMenu: async (_model: NativePopupMenuModel<CommandId>, _anchor?: MenuAnchor) => undefined
    },
    aes: {
      decrypt: async (_encryptedData: string, _iv: string, _secretKey: string) => ''
    },
    shell: {
      openExternal: (url: string, options?: Electron.OpenExternalOptions) => {
        try {
          window.open(url, '_blank', options?.activate === false ? 'noopener' : undefined)
          return Promise.resolve()
        } catch (error) {
          return Promise.reject(error)
        }
      }
    },
    copilot: {
      getAuthMessage: async (_headers?: Record<string, string>) => {
        throw new Error('Not supported in Houdini runtime')
      },
      getCopilotToken: async (_device_code: string, _headers?: Record<string, string>) => {
        throw new Error('Not supported in Houdini runtime')
      },
      saveCopilotToken: async (_access_token: string) => undefined,
      getToken: async (_headers?: Record<string, string>) => {
        throw new Error('Not supported in Houdini runtime')
      },
      logout: async () => undefined,
      getUser: async (_token: string) => {
        throw new Error('Not supported in Houdini runtime')
      }
    },
    externalApps: {
      detectInstalled: async (): Promise<ExternalAppInfo[]> => []
    },
    nutstore: {
      getSSOUrl: async () => '',
      decryptToken: async (_token: string) => '',
      getDirectoryContents: async (_token: string, _path: string) => []
    },
    quoteToMainWindow: async (_text: string) => undefined,
    trace: {
      getData: async (_topicId: string, _traceId: string) => null,
      cleanLocalData: async () => undefined
    },
    shortcut: {
      onRegistrationConflict: (_callback: (payload: ShortcutRegistrationConflictPayload) => void) => noopUnsubscribe()
    },
    cache: {
      broadcastSync: (_message: CacheSyncMessage) => undefined,
      onSync: (_callback: (message: CacheSyncMessage) => void) => noopUnsubscribe(),
      getAllShared: async (): Promise<Record<string, CacheEntry>> => ({})
    },
    storageMonitor: {
      getHealth: async (): Promise<StorageHealth> => ({
        level: 'ok',
        freeBytes: 0,
        totalBytes: 0,
        checkedAt: Date.now()
      }),
      onHealthChange: (_callback: (health: StorageHealth) => void) => noopUnsubscribe()
    },
    preference: createHoudiniPreferenceApi(),
    dataApi: {
      ...createHoudiniGenericRequestApi('dataApi', 'dataApiRequest'),
      onDataChanged: (_callback: (effects: DataApiDataChangeEffect[]) => void) => noopUnsubscribe()
    },
    ipcApi: createHoudiniGenericRequestApi('ipcApi', 'ipcApiRequest'),
    skill: createHoudiniSkillApi(),
    lanTransfer: {
      startScan: async (): Promise<LanTransferState> => ({
        services: [],
        isScanning: false,
        lastUpdatedAt: Date.now()
      }),
      stopScan: async (): Promise<LanTransferState> => ({ services: [], isScanning: false, lastUpdatedAt: Date.now() }),
      connect: async (_payload: LanTransferConnectPayload) => {
        throw new Error('Not supported in Houdini runtime')
      },
      disconnect: async () => undefined,
      onServicesUpdated: (_callback: (state: LanTransferState) => void) => noopUnsubscribe(),
      onClientEvent: (_callback: (event: LanClientEvent) => void) => noopUnsubscribe(),
      sendFile: async (_filePath: string) => {
        throw new Error('Not supported in Houdini runtime')
      },
      cancelTransfer: async () => undefined
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    if (isHoudiniEnvironment()) {
      console.log('[Preload] Detected Houdini/non-Electron environment, using mock APIs')
      contextBridge.exposeInMainWorld('electron', createHoudiniElectronAPI())
      contextBridge.exposeInMainWorld('api', createHoudiniAPI())
    } else {
      contextBridge.exposeInMainWorld('electron', electronAPI)
      contextBridge.exposeInMainWorld('api', api)
    }
  } catch (error) {
    console.error('[Preload]Failed to expose APIs:', error as Error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}

export type WindowApiType = typeof api
