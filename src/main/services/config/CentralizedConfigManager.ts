/**
 * 中心化配置管理器
 * 负责读取中心化配置（只读，不可修改）
 */

import * as fs from 'fs-extra'
import path from 'path'

import { loggerService } from '@logger'
import { app } from 'electron'

import type { CentralizedConfig } from './types'

const logger = loggerService.withContext('CentralizedConfigManager')

export class CentralizedConfigManager {
  private configPath: string
  private config: CentralizedConfig | null = null

  constructor() {
    // 中心化配置文件路径：resources/centralized-config.json
    // 优先使用环境变量 CHERRY_STUDIO_CENTRALIZED_CONFIG_PATH
    if (process.env.CHERRY_STUDIO_CENTRALIZED_CONFIG_PATH) {
      this.configPath = process.env.CHERRY_STUDIO_CENTRALIZED_CONFIG_PATH
      logger.info(`Using centralized config from environment variable: ${this.configPath}`)
    } else if (process.env.NODE_ENV === 'development') {
      // 开发环境：项目根目录下的 resources/centralized-config.json
      this.configPath = path.join(app.getAppPath(), '..', 'resources', 'centralized-config.json')
    } else {
      // 生产环境：尝试从多个可能的位置查找配置文件
      // 1. 应用安装目录旁边的 centralized-config.json
      // 2. resources 目录下的 centralized-config.json
      const possiblePaths = [
        path.join(path.dirname(app.getPath('exe')), 'centralized-config.json'),
        path.join((process as any).resourcesPath, 'centralized-config.json')
      ]
      
      // 默认使用第一个路径
      this.configPath = possiblePaths[0]
      
      // 尝试找到第一个存在的文件
      for (const p of possiblePaths) {
        if (fs.pathExistsSync(p)) {
          this.configPath = p
          logger.info(`Found centralized config at: ${this.configPath}`)
          break
        }
      }
      
      // 如果没有找到存在的文件，记录日志
      if (!fs.pathExistsSync(this.configPath)) {
        logger.info(`No centralized config found. Will check: ${this.configPath}`)
      }
    }
  }

  /**
   * 加载中心化配置
   */
  async load(): Promise<CentralizedConfig> {
    try {
      if (this.config) {
        return this.config
      }

      // 检查配置文件是否存在
      if (!(await fs.pathExists(this.configPath))) {
        logger.warn(`Centralized config file not found: ${this.configPath}, using empty config`)
        this.config = this.getDefaultConfig()
        return this.config
      }

      // 读取配置文件
      const configContent = await fs.readJson(this.configPath)
      this.config = this.validateAndNormalizeConfig(configContent)
      
      logger.info(`Centralized config loaded from: ${this.configPath}`)
      return this.config
    } catch (error) {
      logger.error(`Failed to load centralized config: ${error}`)
      this.config = this.getDefaultConfig()
      return this.config
    }
  }

  /**
   * 获取中心化配置（同步方法，如果已加载）
   */
  getConfig(): CentralizedConfig | null {
    return this.config
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<CentralizedConfig> {
    this.config = null
    return this.load()
  }

  /**
   * 验证和规范化配置
   */
  private validateAndNormalizeConfig(config: any): CentralizedConfig {
    const defaultConfig = this.getDefaultConfig()

    // 处理 providers 结构（新格式）或 models 数组（旧格式）
    let models: any[] = []
    if (config.providers && Array.isArray(config.providers)) {
      // 从 providers 中提取所有 models
      config.providers.forEach((provider: any) => {
        if (provider.models && Array.isArray(provider.models)) {
          provider.models.forEach((model: any) => {
            models.push({
              ...model,
              provider: provider.id,
              isCentralized: true
            })
          })
        }
      })
    } else if (config.models && Array.isArray(config.models)) {
      // 旧格式：直接使用 models 数组
      models = config.models.map((m: any) => ({
        ...m,
        isCentralized: true
      }))
    }

    const mcpServers = (config.mcpServers || defaultConfig.mcpServers || []).map((s: any) => ({
      ...s,
      isCentralized: true
    }))

    // 支持 defaultModels 或 defaultModelSettings 字段名
    const defaultModelSettings = config.defaultModels || config.defaultModelSettings || {}

    logger.info(`Normalized centralized config: ${models.length} models, ${mcpServers.length} MCP servers`)
    if (Object.keys(defaultModelSettings).length > 0) {
      logger.info(`Default model settings:`, defaultModelSettings)
    }

    return {
      models,
      mcpServers,
      defaultModelSettings,
      version: config.version || '1.0.0',
      lastUpdated: config.lastUpdated || new Date().toISOString()
    }
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): CentralizedConfig {
    return {
      models: [],
      mcpServers: [],
      defaultModelSettings: {},
      version: '1.0.0',
      lastUpdated: new Date().toISOString()
    }
  }

  /**
   * 获取配置文件路径（用于调试）
   */
  getConfigPath(): string {
    return this.configPath
  }
}

export const centralizedConfigManager = new CentralizedConfigManager()

