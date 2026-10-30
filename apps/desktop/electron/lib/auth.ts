import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProviderCredential } from '@shared/chat'
import { dataDir } from './storage'

/**
 * Per-provider credential storage, in the same spirit as opencode's
 * `auth.json`: a local JSON file with restricted permissions.
 * It uses atomic writing (temp → rename) to avoid corruption on a crash.
 */

function authFile() {
  return path.join(dataDir(), 'auth.json')
}

type AuthData = Record<string, ProviderCredential>

async function readAll(): Promise<AuthData> {
  try {
    return JSON.parse(await fs.readFile(authFile(), 'utf8'))
  } catch (err) {
    // ENOENT = first run (no keys yet); other errors = corruption
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[auth] failed to read auth.json — credentials may have been lost:', err)
    }
    return {}
  }
}

async function writeAll(data: AuthData): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  const file = authFile()
  const tmp = `${file}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, file)
}

export async function getCredential(providerId: string): Promise<ProviderCredential | undefined> {
  const data = await readAll()
  return data[providerId]
}

export async function setCredential(providerId: string, key: string): Promise<void> {
  const data = await readAll()
  data[providerId] = { type: 'api', key }
  await writeAll(data)
}

export async function removeCredential(providerId: string): Promise<void> {
  const data = await readAll()
  delete data[providerId]
  await writeAll(data)
}

/** IDs of the providers with a saved credential (it never exposes the keys to the renderer). */
export async function listCredentialProviders(): Promise<string[]> {
  return Object.keys(await readAll())
}

/** Resolves the API key: saved credential or the catalog's environment variable. */
export async function resolveApiKey(providerId: string, envNames: string[]): Promise<string | undefined> {
  const credential = await getCredential(providerId)
  if (credential?.key) return credential.key
  for (const name of envNames) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}
