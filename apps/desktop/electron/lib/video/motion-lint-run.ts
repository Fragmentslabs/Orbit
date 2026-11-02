import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MotionAudioPlan } from './motion-audio'
import {
  collectAssetRefs,
  lintMotionAudio,
  lintMotionSources,
  lintMotionTransitions,
  localScriptRefs,
  type AssetStatus,
  type LintFinding,
  type LintSource,
} from './motion-lint'
import { lintMotionScenes, type MotionSceneInfo } from './motion-scenes'
import type { MotionTransitionInfo } from './motion-transitions'

/**
 * The part of the lint that touches the DISK: reads the entry HTML and the local scripts,
 * and answers whether a referenced file exists next to the composition. The rules
 * themselves are pure (motion-lint.ts); here only what they need is gathered.
 *
 * Best-effort all the way: a lint that fails NEVER takes down the preview nor the render
 * — the worst case is the report coming out without this section.
 */

/** A composition HTML larger than this is not hand-written code. */
const MAX_ENTRY_BYTES = 1_500_000
/** A script larger than this is a library, even without `.min` in the name. */
const MAX_SCRIPT_BYTES = 300_000

export interface MotionLintInput {
  /** Entry file of the composition (absolute). */
  entry: string
  /** Folder served by the scheme: what is outside it the preview never reaches. */
  folder: string
  /** What the runtime announced, when the composition has already been loaded. */
  runtime?: { fps: number; durationInFrames: number; transitions: MotionTransitionInfo[]; scenes?: MotionSceneInfo[] }
  /** The tracks of the audio manifest, when resolved. */
  audio?: MotionAudioPlan | null
}

/** Relative reference → what lies behind it inside the folder. */
export async function assetStatusIn(folder: string, ref: string): Promise<AssetStatus> {
  let rel = ref.split(/[?#]/)[0]
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return 'missing'
  }
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) return 'ok'
  const root = path.resolve(folder)
  const target = path.resolve(root, rel)
  const inside = path.relative(root, target)
  if (inside.startsWith('..') || path.isAbsolute(inside)) return 'outside'
  const stat = await fsp.stat(target).catch(() => null)
  return stat ? 'ok' : 'missing'
}

/** The AUTHORED scripts of the folder: relative, existing, small and without `.min`. */
async function localScripts(html: string, folder: string): Promise<LintSource[]> {
  const out: LintSource[] = []
  for (const ref of localScriptRefs(html)) {
    if (/\.min\.m?js$/i.test(ref)) continue
    if ((await assetStatusIn(folder, ref)) !== 'ok') continue
    const file = path.resolve(folder, decodeURIComponent(ref.split(/[?#]/)[0]).replace(/^\/+/, ''))
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat?.isFile() || stat.size > MAX_SCRIPT_BYTES) continue
    const text = await fsp.readFile(file, 'utf8').catch(() => null)
    if (text !== null) out.push({ name: path.relative(folder, file).split(path.sep).join('/'), text })
  }
  return out
}

export async function lintMotionComposition(input: MotionLintInput): Promise<LintFinding[]> {
  try {
    const stat = await fsp.stat(input.entry)
    if (stat.size > MAX_ENTRY_BYTES) return []
    const html = await fsp.readFile(input.entry, 'utf8')
    const scripts = await localScripts(html, input.folder)

    // The pure lint is synchronous: the disk is consulted BEFORE, once per reference.
    const status = new Map<string, AssetStatus>()
    for (const { ref } of collectAssetRefs(html)) {
      if (!status.has(ref)) status.set(ref, await assetStatusIn(input.folder, ref))
    }
    const findings = lintMotionSources({ name: path.basename(input.entry), text: html }, scripts, {
      assetStatus: (ref) => status.get(ref) ?? 'ok',
    })
    if (input.runtime) {
      const seconds = input.runtime.durationInFrames / input.runtime.fps
      findings.push(...lintMotionTransitions(input.runtime.transitions, seconds))
      findings.push(...lintMotionScenes(input.runtime.scenes ?? [], seconds))
      if (input.audio) findings.push(...lintMotionAudio(input.audio, seconds))
    }
    return findings
  } catch {
    return []
  }
}
