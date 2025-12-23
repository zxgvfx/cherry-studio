/**
 * 用户配置管理器
 * 负责管理用户本地配置（可读写）
 */

import * as fs from 'fs-extra'
import path from 'path'

import { loggerService } from '@logger'

import { getConfigDir } from '../../utils/file'
import { centralizedConfigManager } from './CentralizedConfigManager'
import type { UserConfig } from './types'

const logger = loggerService.withContext('UserConfigManager')

export class UserConfigManager {
  private configPath: string
  private config: UserConfig | null = null

  constructor() {
    // 用户配置文件路径：~/.cherrystudio/config/user-config.json
    const configDir = getConfigDir()
    this.configPath = path.join(configDir, 'user-config.json')
  }

  /**
   * 加载用户配置
   */
  async load(): Promise<UserConfig> {
    try {
      if (this.config) {
        return this.config
      }

      // 确保配置目录存在
      await fs.ensureDir(path.dirname(this.configPath))

      // 检查配置文件是否存在
      if (!(await fs.pathExists(this.configPath))) {
        logger.info(`User config file not found: ${this.configPath}, creating default config`)
        this.config = this.getDefaultConfig()
        await this.save()
        return this.config
      }

      // 读取配置文件
      const configContent = await fs.readJson(this.configPath)
      this.config = this.validateAndNormalizeConfig(configContent)

      logger.info(`User config loaded from: ${this.configPath}`)
      return this.config
    } catch (error) {
      logger.error(`Failed to load user config: ${error}`)
      this.config = this.getDefaultConfig()
      return this.config
    }
  }

  /**
   * 保存用户配置
   */
  async save(): Promise<void> {
    try {
      if (!this.config) {
        logger.warn('No config to save, loading default config first')
        this.config = this.getDefaultConfig()
      }

      // 确保配置目录存在
      await fs.ensureDir(path.dirname(this.configPath))

      // 更新最后更新时间
      this.config.lastUpdated = new Date().toISOString()

      // 写入配置文件
      await fs.writeJson(this.configPath, this.config, { spaces: 2 })
      logger.info(`User config saved to: ${this.configPath}`)
    } catch (error) {
      logger.error(`Failed to save user config: ${error}`)
      throw error
    }
  }

  /**
   * 获取用户配置（同步方法，如果已加载）
   */
  getConfig(): UserConfig | null {
    return this.config
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<UserConfig> {
    this.config = null
    return this.load()
  }

  /**
   * 更新模型配置
   */
  async updateModels(models: UserConfig['models']): Promise<void> {
    await this.load()
    if (!this.config) {
      throw new Error('Config not loaded')
    }
    // 确保不包含中心化配置的模型
    const centralizedConfig = await centralizedConfigManager.load()
    const centralizedModelIds = new Set(centralizedConfig.models.map((m) => m.id))
    const userModels = models.filter((m) => !centralizedModelIds.has(m.id))
    this.config.models = userModels
    await this.save()
  }

  /**
   * 添加模型配置
   */
  async addModel(model: UserConfig['models'][0]): Promise<void> {
    await this.load()
    if (!this.config) {
      throw new Error('Config not loaded')
    }
    // 检查是否为中心化配置的模型
    const centralizedConfig = await centralizedConfigManager.load()
    const isCentralized = centralizedConfig.models.some((m) => m.id === model.id)
    if (isCentralized) {
      throw new Error(`Cannot modify centralized model: ${model.id}. Centralized models are read-only.`)
    }
    // 检查是否已存在相同ID的模型
    const existingIndex = this.config.models.findIndex((m) => m.id === model.id)
    if (existingIndex >= 0) {
      this.config.models[existingIndex] = model
    } else {
      this.config.models.push(model)
    }
    await this.save()
  }

  /**
   * 删除模型配置
   */
  async removeModel(modelId: string): Promise<void> {
    await this.load()
    if (!this.config) {
      throw new Error('Config not loaded')
    }
    this.config.models = this.config.models.filter((m) => m.id !== modelId)
    await this.save()
  }

  /**
   * 更新MCP服务器配置
   */
  async updateMcpServers(mcpServers: UserConfig['mcpServers']): Promise<void> {
    await this.load()
    if (!this.config) {
      throw new Error('Config not loaded')
    }
    // 确保不包含中心化配置的MCP服务器
    const centralizedConfig = await centralizedConfigManager.load()
    const centralizedServerIds = new Set(centralizedConfig.mcpServers.map((s) => s.id))
    const userMcpServers = mcpServers.filter((s) => !centralizedServerIds.has(s.id))
    this.config.mcpServers = userMcpServers
    await this.save()
  }

  /**
   * 添加MCP服务器配置
   */
  async addMcpServer(server: UserConfig['mcpServers'][0]): Promise<void> {
    await this.load()
    if (!this.config) {
      throw new Error('Config not loaded')
    }
    // 检查是否为中心化配置的MCP服务器
    const centralizedConfig = await centralizedConfigManager.load()
    const isCentralized = centralizedConfig.mcpServers.some((s) => s.id === server.id)
    if (isCentralized) {
      throw new Error(`Cannot modify centralized MCP server: ${server.id}. Centralized MCP servers are read-only.`)
    }
    // 检查是否已存在相同ID的服务器
    const existingIndex = this.config.mcpServers.findIndex((s) => s.id === server.id)
    if (existingIndex >= 0) {
      this.config.mcpServers[existingIndex] = server
    } else {
      this.config.mcpServers.push(server)
    }
    await this.save()
  }

  /**
   * 删除MCP服务器配置
   */
  async removeMcpServer(serverId: string): Promise<void> {
    await this.load()
    if (!this.config) {
      throw new Error('Config not loaded')
    }
    this.config.mcpServers = this.config.mcpServers.filter((s) => s.id !== serverId)
    await this.save()
  }

  /**
   * 验证和规范化配置
   */
  private validateAndNormalizeConfig(config: any): UserConfig {
    const defaultConfig = this.getDefaultConfig()

    // 确保用户配置中不包含isCentralized标记（用户配置都是可修改的）
    const models = Array.isArray(config.models)
      ? config.models.map((m: any) => {
          const { isCentralized, ...rest } = m
          return rest
        })
      : defaultConfig.models

    const mcpServers = Array.isArray(config.mcpServers)
      ? config.mcpServers.map((s: any) => {
          const { isCentralized, ...rest } = s
          return rest
        })
      : defaultConfig.mcpServers

    return {
      models,
      mcpServers,
      version: config.version || defaultConfig.version,
      lastUpdated: config.lastUpdated || new Date().toISOString()
    }
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): UserConfig {
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

export const userConfigManager = new UserConfigManager()

