import { app, dialog, type BrowserWindow, type FileFilter } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson } from './storage'

/**
 * The "Save as…" of every media that leaves Orbit.
 *
 * Before, each export opened wherever it happened to: the tab's render landed inside the
 * composition's internal folder, the deck's PDF in the process's working directory, and
 * the rest depended on the system dialog's memory — which on macOS exists and
 * on Windows does not. Here the rule is a single one: it starts in the last folder in which the person
 * saved something and, the first time (or if that folder is gone), in the system's
 * Downloads folder.
 *
 * The choice is remembered for the whole app, and not per file type: whoever
 * organizes videos in ~/Desktop/videos wants the deck's PDF in the same place.
 */

const STORAGE_KEY = 'export-dir'

/** Last chosen folder — returned only while it still exists. */
async function rememberedDir(): Promise<string | null> {
  const stored = await readJson<{ dir?: string }>(STORAGE_KEY).catch(() => null)
  const dir = stored?.dir
  if (!dir) return null
  try {
    return (await fsp.stat(dir)).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** Where the next dialog opens. */
export async function exportDir(): Promise<string> {
  const remembered = await rememberedDir()
  if (remembered) return remembered
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

/**
 * Safe file name: no path separator, no empty name and no
 * exaggerated length. The name itself comes from the caller — it is the MEDIA's name in
 * Orbit, never a generic "render" or "file".
 */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file'
}

/**
 * Opens the save dialog and returns the chosen path, or `null` if the person
 * canceled (canceling is not an error in any caller). The chosen folder becomes the
 * starting point of the next exports.
 */
export async function saveExport(
  window: BrowserWindow | null,
  input: { title?: string; fileName: string; filters?: FileFilter[] },
): Promise<string | null> {
  const options = {
    title: input.title,
    defaultPath: path.join(await exportDir(), safeFileName(input.fileName)),
    filters: input.filters,
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  // Remember AFTER saving: it is the folder in which the person actually stored it.
  await writeJson(STORAGE_KEY, { dir: path.dirname(result.filePath) }).catch(() => {})
  return result.filePath
}
