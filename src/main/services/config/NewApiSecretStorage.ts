import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'
import { safeStorage } from 'electron'
import * as fs from 'fs-extra'

const logger = loggerService.withContext('NewApiSecretStorage')

export interface StoredNewApiKey {
  providerId: string
  username: string
  userId?: number
  tokenId?: number
  tokenName?: string
  apiKey: string
  /** NewAPI system access token (PAT), used for management APIs like /api/log/self. */
  accessToken?: string
  createdAt: string
  lastValidatedAt?: string
}

interface StoredNewApiKeyPayload extends Omit<StoredNewApiKey, 'apiKey' | 'accessToken'> {
  encryptedApiKey: string
  encryptedAccessToken?: string
}

export class NewApiSecretStorage {
  private readonly secretsDir = path.join(getConfigDir(), 'secrets', 'newapi')

  async get(providerId: string, username: string): Promise<StoredNewApiKey | null> {
    const filePath = this.getSecretPath(providerId, username)
    if (!(await fs.pathExists(filePath))) {
      return null
    }

    try {
      const payload = (await fs.readJson(filePath)) as StoredNewApiKeyPayload
      const apiKey = safeStorage.decryptString(Buffer.from(payload.encryptedApiKey, 'base64'))
      const accessToken = payload.encryptedAccessToken
        ? safeStorage.decryptString(Buffer.from(payload.encryptedAccessToken, 'base64'))
        : undefined
      return {
        ...payload,
        apiKey,
        accessToken
      }
    } catch (error) {
      logger.warn(`Failed to read NewAPI secret for ${providerId}/${username}`, error as Error)
      return null
    }
  }

  async save(secret: StoredNewApiKey): Promise<void> {
    await fs.ensureDir(this.secretsDir)

    const encryptedApiKey = safeStorage.encryptString(secret.apiKey).toString('base64')
    const encryptedAccessToken = secret.accessToken
      ? safeStorage.encryptString(secret.accessToken).toString('base64')
      : undefined
    const payload: StoredNewApiKeyPayload = {
      providerId: secret.providerId,
      username: secret.username,
      userId: secret.userId,
      tokenId: secret.tokenId,
      tokenName: secret.tokenName,
      encryptedApiKey,
      encryptedAccessToken,
      createdAt: secret.createdAt,
      lastValidatedAt: secret.lastValidatedAt
    }

    await fs.writeJson(this.getSecretPath(secret.providerId, secret.username), payload, { spaces: 2 })
  }

  private getSecretPath(providerId: string, username: string): string {
    return path.join(this.secretsDir, `${this.sanitize(providerId)}-${this.sanitize(username)}.json`)
  }

  private sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
  }
}

export const newApiSecretStorage = new NewApiSecretStorage()
