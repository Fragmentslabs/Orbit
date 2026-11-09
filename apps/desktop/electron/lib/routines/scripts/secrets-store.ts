import fsp from 'node:fs/promises'
import path from 'node:path'
import { safeStorage } from 'electron'
import { SECRET_NAME_PATTERN } from '@shared/routines'
import { dataDir } from '../../storage'

/**
 * Named secrets for routine scripts (a read-only GitHub token, an API key). The value is
 * encrypted with the OS keychain (`safeStorage`) when it is available, and only the MAIN process
 * ever reads it back: the screen can list names, add and delete, but nothing returns a value.
 * Kept apart from auth.json (provider keys) so a backup or export of that file never carries them.
 */

/** Shorter values would be scrubbed out of ordinary text. */
const MIN_SECRET_LENGTH = 8

interface StoredSecret {
  value: string
  enc: 'safe' | 'plain'
}

type SecretFile = Record<string, StoredSecret>

function secretsFile(): string {
  return path.join(dataDir(), 'routine-secrets.json')
}

async function readAll(): Promise<SecretFile> {
  try {
    return JSON.parse(await fsp.readFile(secretsFile(), 'utf8')) as SecretFile
  } catch {
    return {}
  }
}

async function writeAll(data: SecretFile): Promise<void> {
  await fsp.mkdir(dataDir(), { recursive: true })
  const file = secretsFile()
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, file)
}

function encrypt(value: string): StoredSecret {
  try {
    if (safeStorage.isEncryptionAvailable()) return { value: safeStorage.encryptString(value).toString('base64'), enc: 'safe' }
  } catch {
    /* falls back to the file's own 0600 permission */
  }
  return { value, enc: 'plain' }
}

/** Names only: this is all the screen and the agents ever get. */
export async function listSecretNames(): Promise<string[]> {
  return Object.keys(await readAll()).sort()
}

export async function setSecret(name: string, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!SECRET_NAME_PATTERN.test(name)) return { ok: false, error: 'The name must be upper case letters, digits and underscores.' }
  if (value.trim().length < MIN_SECRET_LENGTH) return { ok: false, error: `The value must have at least ${MIN_SECRET_LENGTH} characters.` }
  const data = await readAll()
  data[name] = encrypt(value.trim())
  await writeAll(data)
  return { ok: true }
}

export async function removeSecret(name: string): Promise<void> {
  const data = await readAll()
  if (!(name in data)) return
  delete data[name]
  await writeAll(data)
}

/** For the main process only (the script runner): the value of a stored secret, or null. */
export async function readSecretValue(name: string): Promise<string | null> {
  const entry = (await readAll())[name]
  if (!entry) return null
  try {
    return entry.enc === 'safe' ? safeStorage.decryptString(Buffer.from(entry.value, 'base64')) : entry.value
  } catch {
    return null
  }
}
