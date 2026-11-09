import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ScriptActivity } from '@shared/routines'
import { emptyActivity } from './activity'
import { EMPTY_SCRIPT_STATE, type ScriptState } from './runner'
import { scriptsDir } from '../repo'

/** What is kept on disk for one routine's scripts: their memory and the log of the checks. */
export interface ScriptRecord {
  state: ScriptState
  activity: ScriptActivity
}

/** The id becomes a file name. */
function fileFor(routineId: string): string | null {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(routineId) ? path.join(scriptsDir(), `${routineId}.json`) : null
}

export async function readScriptRecord(routineId: string): Promise<ScriptRecord> {
  const file = fileFor(routineId)
  const fresh = (): ScriptRecord => ({ state: EMPTY_SCRIPT_STATE, activity: emptyActivity(routineId) })
  if (!file) return fresh()
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<ScriptRecord>
    return {
      state: { kv: raw.state?.kv ?? {}, seen: raw.state?.seen ?? [] },
      activity: { ...emptyActivity(routineId), ...raw.activity, routineId },
    }
  } catch {
    return fresh()
  }
}

export async function writeScriptRecord(routineId: string, record: ScriptRecord): Promise<void> {
  const file = fileFor(routineId)
  if (!file) return
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(record), 'utf8')
  await fsp.rename(tmp, file)
}

export async function removeScriptRecord(routineId: string): Promise<void> {
  const file = fileFor(routineId)
  if (file) await fsp.rm(file, { force: true })
}
