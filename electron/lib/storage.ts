import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Storage JSON simples baseado em arquivos, seguindo o padrão do opencode:
 * cada chave vira um arquivo `<key>.json` e a escrita é atômica
 * (escreve em arquivo temporário e renomeia).
 */

const KEY_SEGMENT = /^[a-zA-Z0-9_-]+$/

function storageDir() {
  return path.join(app.getPath('userData'), 'orbit-data', 'storage')
}

function fileFor(key: string) {
  const segments = key.split('/')
  for (const segment of segments) {
    if (!KEY_SEGMENT.test(segment)) throw new Error(`Chave de storage inválida: ${key}`)
  }
  return path.join(storageDir(), ...segments) + '.json'
}

export async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(fileFor(key), 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  const file = fileFor(key)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function removeJson(key: string): Promise<void> {
  await fs.rm(fileFor(key), { force: true })
}

/**
 * Variante para arquivos de texto cru (`.md`) — mesma validação de chave e
 * escrita atômica dos JSON. Usada pelos documentos anexados de memória,
 * que ficam legíveis/editáveis fora do app.
 */
function textFileFor(key: string) {
  const segments = key.split('/')
  for (const segment of segments) {
    if (!KEY_SEGMENT.test(segment)) throw new Error(`Chave de storage inválida: ${key}`)
  }
  return path.join(storageDir(), ...segments) + '.md'
}

export async function readText(key: string): Promise<string | null> {
  try {
    return await fs.readFile(textFileFor(key), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeText(key: string, content: string): Promise<void> {
  const file = textFileFor(key)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${Date.now()}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

export async function removeText(key: string): Promise<void> {
  await fs.rm(textFileFor(key), { force: true })
}

/** Lista as chaves existentes sob um prefixo (ex.: "session/"). */
export async function listKeys(prefix: string): Promise<string[]> {
  const base = storageDir()
  const dir = path.join(base, ...prefix.split('/').filter(Boolean))
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => {
        const suffix = e.name.slice(0, -'.json'.length)
        return prefix ? `${prefix.replace(/\/?$/, '/')}${suffix}` : suffix
      })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Diretório raiz de dados do app (auth, cache do catálogo, etc). */
export function dataDir() {
  return path.join(app.getPath('userData'), 'orbit-data')
}
