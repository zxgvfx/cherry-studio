/**
 * One NewAPI management PAT (access token) per apiHost + username.
 * NewAPI rotates PAT on each issue; multiple coco-* providers must share one PAT.
 */

import path from 'node:path'

import { getConfigDir } from '@main/utils/file'
import { safeStorage } from 'electron'
import * as fs from 'fs-extra'

export class AccessTokenInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessTokenInvalidError'
  }
}

function normalizeApiHost(apiHost: string): string {
  return apiHost.trim().replace(/\/+$/, '').toLowerCase()
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function sharedPatPath(apiHost: string, username: string): string {
  const host = sanitize(normalizeApiHost(apiHost).replace(/:\/\//g, '_'))
  const user = sanitize(username)
  return path.join(getConfigDir(), 'secrets', 'newapi', `_shared-pat_${host}_${user}.json`)
}

export async function loadSharedAccessToken(apiHost: string, username: string): Promise<string | undefined> {
  const filePath = sharedPatPath(apiHost, username)
  if (!(await fs.pathExists(filePath))) {
    return undefined
  }
  try {
    const payload = (await fs.readJson(filePath)) as { encryptedAccessToken?: string }
    if (!payload.encryptedAccessToken) {
      return undefined
    }
    return safeStorage.decryptString(Buffer.from(payload.encryptedAccessToken, 'base64'))
  } catch {
    return undefined
  }
}

export async function saveSharedAccessToken(
  apiHost: string,
  username: string,
  accessToken: string,
  userId?: number
): Promise<void> {
  const filePath = sharedPatPath(apiHost, username)
  await fs.ensureDir(path.dirname(filePath))
  await fs.writeJson(
    filePath,
    {
      username,
      apiHost: normalizeApiHost(apiHost),
      userId,
      encryptedAccessToken: safeStorage.encryptString(accessToken).toString('base64')
    },
    { spaces: 2 }
  )
}

export function isAccessTokenInvalidMessage(message: unknown): boolean {
  const text = String(message || '').toLowerCase()
  return text.includes('invalid access token') || text.includes('unauthorized')
}
