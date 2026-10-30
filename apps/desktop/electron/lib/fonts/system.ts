import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * The families installed on the computer, for the inspector's font selector.
 *
 * It is a list of NAMES (what `font-family` accepts), not of files: the system font
 * is already loaded by Chromium, so the name is enough. On Windows the source of
 * truth is the registry — the entries come as "Arial Bold (TrueType)", which is a
 * FACE and not a family; without stripping the suffix the element's `font-family`
 * would point at a family that does not exist.
 */

const execFileAsync = promisify(execFile)
const CACHE_MS = 5 * 60 * 1000

/** Words that are a STYLE, not a name: "Segoe UI Semibold" → "Segoe UI". */
const STYLE_WORDS =
  /\s+(?:bold|italic|oblique|black|heavy|light|thin|medium|semibold|semi\s?bold|demibold|demi\s?bold|extrabold|extra\s?bold|ultrabold|ultra\s?bold|extralight|extra\s?light|ultralight|ultra\s?light|regular|book|roman|normal)$/i

let cache: { at: number; families: string[] } | null = null

/** Strips the style suffix (repeatedly: "Bold Italic" is two of them). */
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
  // `reg` speaks the console codepage: if utf8 does not check out, latin1 is more faithful.
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
      // A missing key (HKCU starts out empty) is not an error.
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
    // `fc-list` returns several families per file, separated by commas.
    return stdout
      .split(/\r?\n/)
      .flatMap((line) => line.split(','))
      .map((name) => name.trim())
      .filter(Boolean)
  } catch {
    return directoryFamilies([path.join(os.homedir(), '.local', 'share', 'fonts'), '/usr/share/fonts', '/usr/local/share/fonts'])
  }
}

/** Installed families, sorted and without repetition (short cache: opening the selector is frequent). */
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
