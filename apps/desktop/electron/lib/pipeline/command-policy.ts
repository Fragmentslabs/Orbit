import type { CommandPolicy } from '@shared/pipeline'

/**
 * Three-layer command policy (§8 of the design). It is the guardrail that
 * replaces the permission prompt: the pipeline runs unsupervised, so the
 * irreversible is refused and whatever leaves the machine is recorded in the
 * phase note.
 *
 * blocked    → refused (counts as a phase failure, the agent has to work around it)
 * controlled → runs and is recorded
 * free       → anything outside both lists
 */

export type Layer = 'blocked' | 'controlled' | 'free'

/** Normalizes for comparison: lowercase, quotes stripped, spaces collapsed. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * One shell command can chain several (`a && b`, `a; b`, `a | b`) — every
 * segment is classified, and the result is the MOST restrictive one found.
 * Without that, `npm test && git push --force` would pass as free.
 */
function segments(command: string): string[] {
  return command
    .split(/(?:\|\||&&|;|\||\n)/)
    .map((s) => normalize(s))
    .filter(Boolean)
}

function matches(segment: string, pattern: string): boolean {
  const target = normalize(pattern)
  // A prefix covers "git push --force origin main"; includes covers the patterns
  // that show up in the middle (e.g. "drop table" inside a -c "...").
  return segment.startsWith(target) || segment.includes(` ${target}`) || segment.includes(target + ' ')
}

export interface Classification {
  layer: Layer
  /** Segment that drove the classification (for the refusal/record message) */
  reason?: string
}

export function classifyCommand(command: string, policy: CommandPolicy): Classification {
  let controlled: string | undefined
  for (const segment of segments(command)) {
    for (const pattern of policy.blocked) {
      if (matches(segment, pattern)) return { layer: 'blocked', reason: pattern }
    }
    if (!controlled) {
      for (const pattern of policy.controlled) {
        if (matches(segment, pattern)) {
          controlled = pattern
          break
        }
      }
    }
  }
  return controlled ? { layer: 'controlled', reason: controlled } : { layer: 'free' }
}

/** Text handed back to the agent when the command is refused. */
export function blockedMessage(command: string, reason?: string): string {
  return [
    `Command refused by the pipeline policy${reason ? ` (rule: ${reason})` : ''}: ${command}`,
    'This command is irreversible or too dangerous for an unsupervised run.',
    'Solve the task without it — if it is really indispensable, record that in the phase note and finish by reporting why it could not be done.',
  ].join('\n')
}
