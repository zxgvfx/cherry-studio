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
    } else if (process.env.NODE_ENV === 'development') {
      this.configPath = path.join(app.getAppPath(), 'centralized-config.json')
    } else {
      this.configPath = path.join((process as any).resourcesPath, 'centralized-config.json')
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

    // 确保所有模型和MCP服务器都标记为只读
    const models = (config.models || defaultConfig.models || []).map((m: any) => ({
      ...m,
      isCentralized: true
    }))

    const mcpServers = (config.mcpServers || defaultConfig.mcpServers || []).map((s: any) => ({
      ...s,
      isCentralized: true
    }))

    return {
      models,
      mcpServers,
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

