/**
 * 配置类型定义
 */

import type { MCPServer } from '@types'

export interface NewApiProvisioningConfig {
  provider?: 'newapi'
  tokenName?: string
  group?: string
  initialQuotaUsd?: number
  topupUsd?: number
  unlimitedQuota?: boolean
  usernameSource?: 'local-config' | 'system' | 'ldap'
  endpoint?: string
  /** Shared secret sent as X-Provision-Secret to the provisioning endpoint. */
  secret?: string
}

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

export interface ProviderConfig {
  id: string
  name: string
  type: string
  apiHost: string
  apiKey?: string
  apiKeyMode?: 'static' | 'per-user-provisioned'
  provisioning?: NewApiProvisioningConfig
  icon?: string
  models: ModelConfig[]
  isCentralized?: boolean
  [key: string]: any
}

export interface WebSearchProviderConfig {
  id: string
  name: string
  apiHost?: string
  apiKey?: string
  isCentralized?: boolean
  [key: string]: any
}

/**
 * 默认模型配置
 */
export interface DefaultModelSettings {
  quickModel?: string // 快速模型ID
  translateModel?: string // 翻译模型ID
  defaultModel?: string // 默认助手模型ID
}

/**
 * 中心化配置
 * 只读，不可修改
 */
export interface CentralizedConfig {
  models: ModelConfig[]
  mcpServers: MCPServer[]
  centralizedProviders: ProviderConfig[]
  centralizedWebSearchProviders: WebSearchProviderConfig[]
  defaultModelSettings?: DefaultModelSettings
  defaultModels?: DefaultModelSettings
  pythonVenv?: string
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
  defaultModelSettings?: DefaultModelSettings
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
  defaultModelSettings: DefaultModelSettings
  defaultModels: DefaultModelSettings
  centralizedProviders: ProviderConfig[]
  centralizedWebSearchProviders: WebSearchProviderConfig[]
  centralizedModels: ModelConfig[] // 中心化模型（只读）
  centralizedMcpServers: MCPServer[] // 中心化MCP服务器（只读）
  userModels: ModelConfig[] // 用户模型（可修改）
  userMcpServers: MCPServer[] // 用户MCP服务器（可修改）
  pythonVenv?: string
  version: string
  lastUpdated: string
}
