import fs from 'node:fs/promises'
import path from 'node:path'
import type { Routine } from '@shared/routines'
import { dataDir } from '../storage'

/**
 * The routine's own folder — the one that belongs to it, not the projects it works on.
 *
 * It is created together with the routine and holds what has to survive between executions:
 * the memory (memory.md), the scripts (scripts/) and whatever the agent produces there.
 * The routine's `folders` are EXTRA folders: where it goes to read, edit and run things.
 */

export const ROUTINE_MEMORY_FILE = 'memory.md'

export function routinesRoot(): string {
  return path.join(dataDir(), 'rotinas')
}

/** Folder name from the title: no accents, no spaces, short. */
export function routineSlug(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'rotina'
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  )
}

/** The memory file template: what the agent reads before and updates after each run. */
export function memoryTemplate(title: string): string {
  return [
    `# Memória da rotina: ${title}`,
    '',
    'Este arquivo é da rotina. O agente lê antes de cada execução e registra aqui o que',
    'precisa lembrar na próxima: decisões, pendências, o que já foi revisado.',
    '',
  ].join('\n')
}

/** Creates the routine's own folder (memory.md + scripts/) and returns its path. */
export async function createRoutineFolder(title: string, taken: Iterable<string> = []): Promise<string> {
  const root = routinesRoot()
  const used = new Set(taken)
  const slug = routineSlug(title)
  let folder = path.join(root, slug)
  for (let n = 2; (await exists(folder)) || used.has(folder); n++) folder = path.join(root, `${slug}-${n}`)
  await fs.mkdir(path.join(folder, 'scripts'), { recursive: true })
  await fs.writeFile(path.join(folder, ROUTINE_MEMORY_FILE), memoryTemplate(title), { flag: 'wx' }).catch(() => undefined)
  return folder
}

/** The folder of an existing routine; creates it when missing (routines from before the folder existed). */
export async function ensureRoutineFolder(routine: Routine): Promise<string> {
  const folder = routine.folder ?? (await createRoutineFolder(routine.title))
  await fs.mkdir(path.join(folder, 'scripts'), { recursive: true }).catch(() => undefined)
  await fs.access(path.join(folder, ROUTINE_MEMORY_FILE)).catch(() =>
    fs.writeFile(path.join(folder, ROUTINE_MEMORY_FILE), memoryTemplate(routine.title)).catch(() => undefined),
  )
  return folder
}

/** Content of memory.md — empty string when there is none. */
export async function readMemory(folder: string): Promise<string> {
  return fs.readFile(path.join(folder, ROUTINE_MEMORY_FILE), 'utf8').catch(() => '')
}
