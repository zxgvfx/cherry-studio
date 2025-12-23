/**
 * 配置类型定义
 */

import type { MCPServer } from '@types'

/**
 * 模型配置
 */
export interface ModelConfig {
  id: string
  name: string
  provider: string
  modelId: string
  apiKey?: string
  baseUrl?: string
  description?: string
  /** 标记是否为中心化配置（只读），如果为true则不可修改 */
  isCentralized?: boolean
  [key: string]: any // 允许扩展字段
}

/**
 * 中心化配置
 * 只读，不可修改
 */
export interface CentralizedConfig {
  models: ModelConfig[]
  mcpServers: MCPServer[]
  version: string
  lastUpdated: string
}

/**
 * 用户配置
 * 可修改，存储在用户本地
 */
export interface UserConfig {
  models: ModelConfig[]
  mcpServers: MCPServer[]
  version: string
  lastUpdated: string
}

/**
 * 合并后的配置
 * 中心化配置 + 用户配置
 */
export interface MergedConfig {
  models: ModelConfig[]
  mcpServers: MCPServer[]
  centralizedModels: ModelConfig[] // 中心化模型（只读）
  centralizedMcpServers: MCPServer[] // 中心化MCP服务器（只读）
  userModels: ModelConfig[] // 用户模型（可修改）
  userMcpServers: MCPServer[] // 用户MCP服务器（可修改）
  version: string
  lastUpdated: string
}

