import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * As famílias instaladas no computador, para o seletor de fonte do inspetor.
 *
 * É uma lista de NOMES (o que `font-family` aceita), não de arquivos: a fonte
 * do sistema já é carregada pelo Chromium, então basta o nome. No Windows a
 * fonte da verdade é o registro — as entradas vêm como "Arial Bold (TrueType)",
 * que é FACE e não família; sem tirar o sufixo o `font-family` do elemento
 * apontaria para uma família que não existe.
 */

const execFileAsync = promisify(execFile)
const CACHE_MS = 5 * 60 * 1000

/** Palavras que são ESTILO, não nome: "Segoe UI Semibold" → "Segoe UI". */
const STYLE_WORDS =
  /\s+(?:bold|italic|oblique|black|heavy|light|thin|medium|semibold|semi\s?bold|demibold|demi\s?bold|extrabold|extra\s?bold|ultrabold|ultra\s?bold|extralight|extra\s?light|ultralight|ultra\s?light|regular|book|roman|normal)$/i

let cache: { at: number; families: string[] } | null = null

/** Tira o sufixo de estilo (repetidamente: "Bold Italic" são dois). */
export function familyOf(name: string): string {
  let value = name
    .replace(/\s*\((?:TrueType|OpenType|Type\s?1|PostScript)\)\s*$/i, '')
    .replace(/_/g, ' ')
    .trim()
  for (let i = 0; i < 4; i += 1) {
    const next = value.replace(STYLE_WORDS, '').trim()
    if (next === value || !next) break
    value = next
  }
  return value.replace(/\s+/g, ' ').trim()
}

function decode(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8')
  // O `reg` fala a codepage do console: se o utf8 não fecha, latin1 é mais fiel.
  return utf8.includes('\uFFFD') ? buffer.toString('latin1') : utf8
}

async function windowsFamilies(): Promise<string[]> {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  ]
  const names: string[] = []
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' })
      for (const line of decode(stdout).split(/\r?\n/)) {
        const at = line.indexOf('    REG_')
        if (at <= 0) continue
        const raw = line.slice(0, at).trim()
        if (!raw || raw.startsWith('@')) continue
        names.push(raw)
      }
    } catch {
      // Chave ausente (HKCU nasce vazia) não é erro.
    }
  }
  return names
}

async function directoryFamilies(dirs: string[]): Promise<string[]> {
  const names: string[] = []
  for (const dir of dirs) {
    const entries = await fsp.readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      if (!/\.(?:ttf|otf|ttc|woff2?)$/i.test(entry)) continue
      names.push(path.basename(entry, path.extname(entry)).replace(/[-_]/g, ' '))
    }
  }
  return names
}

async function linuxFamilies(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('fc-list', ['--format=%{family}\\n'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    // `fc-list` devolve várias famílias por arquivo, separadas por vírgula.
    return stdout
      .split(/\r?\n/)
      .flatMap((line) => line.split(','))
      .map((name) => name.trim())
      .filter(Boolean)
  } catch {
    return directoryFamilies([path.join(os.homedir(), '.local', 'share', 'fonts'), '/usr/share/fonts', '/usr/local/share/fonts'])
  }
}

/** Famílias instaladas, ordenadas e sem repetição (cache curto: abrir o seletor é frequente). */
export async function listSystemFonts(): Promise<string[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.families

  let names: string[]
  if (process.platform === 'win32') names = await windowsFamilies()
  else if (process.platform === 'darwin')
    names = await directoryFamilies([
      path.join(os.homedir(), 'Library', 'Fonts'),
      '/Library/Fonts',
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
    ])
  else names = await linuxFamilies()

  const families = [...new Set(names.map(familyOf).filter((name) => name.length > 0))]
    .filter((name) => !/^[.@]/.test(name))
    .sort((a, b) => a.localeCompare(b))

  cache = { at: now, families }
  return families
}
