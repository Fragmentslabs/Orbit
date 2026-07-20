import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProviderCredential } from '@shared/chat'
import { dataDir } from './storage'

/**
 * Armazenamento de credenciais por provedor, no mesmo espírito do
 * `auth.json` do opencode: um arquivo JSON local com permissões restritas.
 * Usa escrita atômica (temp → rename) para evitar corrupção em crash.
 */

function authFile() {
  return path.join(dataDir(), 'auth.json')
}

type AuthData = Record<string, ProviderCredential>

async function readAll(): Promise<AuthData> {
  try {
    return JSON.parse(await fs.readFile(authFile(), 'utf8'))
  } catch (err) {
    // ENOENT = primeira execução (ainda sem chaves); outros erros = corrupção
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[auth] erro ao ler auth.json — chaves podem ter sido perdidas:', err)
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

/** IDs dos provedores com credencial salva (nunca expõe as chaves ao renderer). */
export async function listCredentialProviders(): Promise<string[]> {
  return Object.keys(await readAll())
}

/** Resolve a chave de API: credencial salva ou variável de ambiente do catálogo. */
export async function resolveApiKey(providerId: string, envNames: string[]): Promise<string | undefined> {
  const credential = await getCredential(providerId)
  if (credential?.key) return credential.key
  for (const name of envNames) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}
