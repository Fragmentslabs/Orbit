import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

/**
 * Instruction files the repository carries for agents: `AGENTS.md` (the open
 * convention) and `CLAUDE.md`. What the team wrote there — how to build, what not
 * to touch, the house style — is the cheapest context there is, and the agent
 * would otherwise only learn it by luck.
 *
 * Discovery walks from the working folder up to the repository root (the folder
 * with a `.git`), so a monorepo package gets its own file AND the root's. In one
 * folder `AGENTS.md` wins over `CLAUDE.md`: repositories that keep both usually
 * keep them as copies of each other, and sending both would spend the budget twice.
 */

const FILE_NAMES = ['AGENTS.md', 'CLAUDE.md']
const MAX_FILE_CHARS = 8_000
const MAX_TOTAL_CHARS = 16_000
const MAX_LEVELS = 8

export interface ContextFile {
  path: string
  content: string
}

function folderChain(directory: string): string[] {
  const home = os.homedir()
  const chain: string[] = []
  let dir = path.resolve(directory)
  for (let i = 0; i < MAX_LEVELS; i++) {
    chain.push(dir)
    if (existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    // Never climb out of the repository's neighbourhood: a stray CLAUDE.md in the
    // home folder or at the filesystem root is not this project's.
    if (parent === dir || parent === home || dir === home) {
      if (dir === home) chain.pop()
      break
    }
    dir = parent
  }
  return chain
}

async function readFirst(dir: string): Promise<ContextFile | null> {
  for (const name of FILE_NAMES) {
    const file = path.join(dir, name)
    try {
      const raw = (await readFile(file, 'utf8')).trim()
      if (!raw) continue
      const content = raw.length > MAX_FILE_CHARS ? `${raw.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : raw
      return { path: file, content }
    } catch {
      // not there, or unreadable: try the next name
    }
  }
  return null
}

/** Outermost folder first, so the more specific file comes later and can override. */
export async function discoverContextFiles(directories: string[]): Promise<ContextFile[]> {
  const seen = new Set<string>()
  const found: ContextFile[] = []
  for (const directory of directories) {
    const chain = folderChain(directory)
    const files: ContextFile[] = []
    for (const dir of chain) {
      const file = await readFirst(dir)
      if (file && !seen.has(file.path)) {
        seen.add(file.path)
        files.push(file)
      }
    }
    found.push(...files.reverse())
  }
  return found
}

export function formatContextFiles(files: ContextFile[]): string {
  if (!files.length) return ''
  let budget = MAX_TOTAL_CHARS
  const blocks: string[] = []
  for (const f of files) {
    if (budget <= 0) break
    const body = f.content.length > budget ? `${f.content.slice(0, budget)}\n… (truncated)` : f.content
    budget -= body.length
    blocks.push(`<file path="${f.path}">\n${body}\n</file>`)
  }
  return (
    'PROJECT INSTRUCTIONS. The repository carries these instruction files for agents. Follow them as the project\'s own conventions; ' +
    'when one conflicts with what the user asks in this conversation, the user wins. Files later in the list are more specific.\n' +
    blocks.join('\n')
  )
}

export async function projectContextBlock(directory: string, extraDirectories: string[] = []): Promise<string> {
  return formatContextFiles(await discoverContextFiles([directory, ...extraDirectories]))
}
