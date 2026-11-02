import type { LintFinding } from './motion-lint'

/**
 * The scenes a composition laid out with `orbitMotion.scenes([...])` (motion-helpers.ts), as the
 * page reports them: name and the seconds it starts and ends on the piece clock. The report
 * shows them, and the lint compares their sum with the length of the piece — the mismatch the
 * agent used to keep in step by hand between the meta and a "durationInFrames".
 */
export interface MotionSceneInfo {
  name: string
  start: number
  end: number
}

const at = (seconds: number): string => `${Number(seconds.toFixed(2))}s`

export function describeScenes(scenes: MotionSceneInfo[]): string {
  if (scenes.length === 0) return ''
  return `Scenes (orbitMotion.scenes — change a duration and the ones after it move): ${scenes.map((s) => `${s.name} ${at(s.start)}→${at(s.end)}`).join(' · ')}.`
}

/** The scenes against the piece's length, in seconds. */
export function lintMotionScenes(scenes: MotionSceneInfo[], durationSeconds: number): LintFinding[] {
  if (scenes.length === 0) return []
  const end = Math.max(...scenes.map((s) => s.end))
  if (end > durationSeconds + 0.05) {
    const lost = scenes.filter((s) => s.end > durationSeconds + 0.05).map((s) => s.name)
    return [
      {
        rule: 'scenes-cut-off',
        severity: 'error',
        message: `the scenes add up to ${at(end)} but the piece lasts ${at(durationSeconds)} — ${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} cut off`,
        hint: 'remove the fixed duration from the <meta> (duration=auto) so the scenes set the length, or make it match',
      },
    ]
  }
  if (end < durationSeconds - 0.5) {
    return [
      {
        rule: 'scenes-short',
        severity: 'warning',
        message: `the scenes end at ${at(end)} but the piece lasts ${at(durationSeconds)} — ${at(durationSeconds - end)} of the end has no scene`,
        hint: 'add the closing scene, or let the scenes set the length (<meta … duration=auto>)',
      },
    ]
  }
  return []
}
