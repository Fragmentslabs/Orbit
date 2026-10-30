import { StorageKeys } from '@shared/chat'
import { readJson } from './storage'

/**
 * Effective app language (English name, e.g. "Portuguese"), published by the
 * renderer on boot and on every switch (channel `app:setLanguage`).
 *
 * It exists because the main process does not read the renderer's localStorage,
 * and the routine scheduler fires agents without any request coming from there
 * — without this value they would answer in the prompt's language.
 *
 * It is persisted, and not kept in memory, because a delayed routine can fire
 * right after boot, before the renderer mounts and publishes.
 *
 * Module kept separate from storage.ts on purpose: that one is the file layer
 * and knows no domain types.
 */
export async function readAppLanguage(): Promise<string | undefined> {
  return (await readJson<string>(StorageKeys.appLanguage)) ?? undefined
}
