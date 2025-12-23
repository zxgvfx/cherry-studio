/**
 * 统一配置服务
 * 负责合并中心化配置和用户配置，提供统一的配置访问接口
 */

import { loggerService } from '@logger'

import { centralizedConfigManager } from './CentralizedConfigManager'
import type { MergedConfig, ModelConfig } from './types'
import { userConfigManager } from './UserConfigManager'
import type { MCPServer } from '@types'

const logger = loggerService.withContext('ConfigService')

export class ConfigService {
  private mergedConfig: MergedConfig | null = null

  /**
   * 加载并合并配置
   * 先加载中心化配置，再加载用户配置，然后合并
   */
  async load(): Promise<MergedConfig> {
    try {
      // 先加载中心化配置（只读）
      const centralizedConfig = await centralizedConfigManager.load()
      
      // 再加载用户配置（可读写）
      const userConfig = await userConfigManager.load()

      // 合并配置
      this.mergedConfig = this.mergeConfigs(centralizedConfig, userConfig)
      
      logger.info('Config merged successfully', {
        centralizedModels: centralizedConfig.models.length,
        centralizedMcpServers: centralizedConfig.mcpServers.length,
        userModels: userConfig.models.length,
        userMcpServers: userConfig.mcpServers.length
      })

      return this.mergedConfig
    } catch (error) {
      logger.error(`Failed to load and merge configs: ${error}`)
      throw error
    }
  }

  /**
   * 获取合并后的配置（同步方法，如果已加载）
   */
  getMergedConfig(): MergedConfig | null {
    return this.mergedConfig
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<MergedConfig> {
    this.mergedConfig = null
    // 同时重新加载中心化和用户配置
    await centralizedConfigManager.reload()
    await userConfigManager.reload()
    return this.load()
  }

  /**
   * 获取所有模型（合并后的）
   */
  async getModels(): Promise<ModelConfig[]> {
    const config = await this.load()
    return config.models
  }

  /**
   * 获取所有MCP服务器（合并后的）
   */
  async getMcpServers(): Promise<MCPServer[]> {
    const config = await this.load()
    return config.mcpServers
  }

  /**
   * 获取中心化模型（只读）
   */
  async getCentralizedModels(): Promise<ModelConfig[]> {
    const config = await this.load()
    return config.centralizedModels
  }

  /**
   * 获取中心化MCP服务器（只读）
   */
  async getCentralizedMcpServers(): Promise<MCPServer[]> {
    const config = await this.load()
    return config.centralizedMcpServers
  }

  /**
   * 获取用户模型（可修改）
   */
  async getUserModels(): Promise<ModelConfig[]> {
    const config = await this.load()
    return config.userModels
  }

  /**
   * 获取用户MCP服务器（可修改）
   */
  async getUserMcpServers(): Promise<MCPServer[]> {
    const config = await this.load()
    return config.userMcpServers
  }

  /**
   * 检查模型是否为中心化配置（只读）
   */
  async isModelCentralized(modelId: string): Promise<boolean> {
    const centralizedModels = await this.getCentralizedModels()
    return centralizedModels.some((m) => m.id === modelId)
  }

  /**
   * 检查MCP服务器是否为中心化配置（只读）
   */
  async isMcpServerCentralized(serverId: string): Promise<boolean> {
    const centralizedServers = await this.getCentralizedMcpServers()
    return centralizedServers.some((s) => s.id === serverId)
  }

  /**
   * 合并配置
   * 用户配置会覆盖中心化配置中相同ID的项
   */
  private mergeConfigs(
    centralized: { models: ModelConfig[]; mcpServers: MCPServer[] },
    user: { models: ModelConfig[]; mcpServers: MCPServer[]; version?: string; lastUpdated?: string }
  ): MergedConfig {
    // 创建ID映射，用于快速查找
    const userModelIds = new Set(user.models.map((m) => m.id))
    const userServerIds = new Set(user.mcpServers.map((s) => s.id))

    // 过滤出未被用户配置覆盖的中心化模型
    const centralizedModels = centralized.models.filter((m) => !userModelIds.has(m.id))
    
    // 过滤出未被用户配置覆盖的中心化MCP服务器
    const centralizedMcpServers = centralized.mcpServers.filter((s) => !userServerIds.has(s.id))

    // 合并模型：中心化模型 + 用户模型
    const mergedModels = [...centralizedModels, ...user.models]

    // 合并MCP服务器：中心化服务器 + 用户服务器
    const mergedMcpServers = [...centralizedMcpServers, ...user.mcpServers]

    return {
      models: mergedModels,
      mcpServers: mergedMcpServers,
      centralizedModels,
      centralizedMcpServers,
      userModels: user.models,
      userMcpServers: user.mcpServers,
      version: user.version || '1.0.0',
      lastUpdated: user.lastUpdated || new Date().toISOString()
    }
  }
}

export const configService = new ConfigService()

