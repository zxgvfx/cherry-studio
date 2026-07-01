import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'
import * as fs from 'fs-extra'

const logger = loggerService.withContext('NewApiIdentityResolver')

interface LocalNewApiUserConfig {
  username?: string
}

export class NewApiIdentityResolver {
  private readonly userConfigPath = path.join(getConfigDir(), 'newapi-user.json')

  async resolveUsername(usernameSource: string = 'local-config'): Promise<string> {
    if (usernameSource === 'local-config') {
      const localUsername = await this.readLocalUsername()
      if (localUsername) {
        return localUsername
      }
    }

    if (usernameSource === 'ldap') {
      logger.warn('LDAP username resolution is not implemented yet, falling back to system username')
    }

    const username = os.userInfo().username || process.env.USERNAME || process.env.USER
    if (!username) {
      throw new Error('Unable to resolve NewAPI username')
    }

    return username
  }

  private async readLocalUsername(): Promise<string | null> {
    if (!(await fs.pathExists(this.userConfigPath))) {
      return null
    }

    const config = (await fs.readJson(this.userConfigPath)) as LocalNewApiUserConfig
    const username = config.username?.trim()
    return username || null
  }
}

export const newApiIdentityResolver = new NewApiIdentityResolver()
