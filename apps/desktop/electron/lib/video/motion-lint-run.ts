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
import type { MotionTransitionInfo } from './motion-transitions'

/**
 * A parte do lint que toca o DISCO: ler o HTML de entrada e os scripts locais,
 * e responder se um arquivo referenciado existe ao lado da composição. As regras
 * em si são puras (motion-lint.ts); aqui só se junta o que elas precisam.
 *
 * Best-effort por inteiro: um lint que falha NUNCA derruba o preview nem o render
 * — o pior caso é o relatório sair sem esta seção.
 */

/** Um HTML de composição maior que isso não é código escrito à mão. */
const MAX_ENTRY_BYTES = 1_500_000
/** Script maior que isso é biblioteca, mesmo sem `.min` no nome. */
const MAX_SCRIPT_BYTES = 300_000

export interface MotionLintInput {
  /** Arquivo de entrada da composição (absoluto). */
  entry: string
  /** Pasta servida pelo scheme: o que fica fora dela o preview nunca alcança. */
  folder: string
  /** O que o runtime anunciou, quando a composição já foi carregada. */
  runtime?: { fps: number; durationInFrames: number; transitions: MotionTransitionInfo[] }
  /** As faixas do manifest de áudio, quando resolvidas. */
  audio?: MotionAudioPlan | null
}

/** Referência relativa → o que há por trás dela dentro da pasta. */
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

/** Os scripts AUTORAIS da pasta: relativos, existentes, pequenos e sem `.min`. */
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

    // O lint puro é síncrono: o disco é consultado ANTES, uma vez por referência.
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
      if (input.audio) findings.push(...lintMotionAudio(input.audio, seconds))
    }
    return findings
  } catch {
    return []
  }
}
