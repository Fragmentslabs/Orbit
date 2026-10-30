/**
 * How Orbit speaks (Preferences → Behavior).
 *
 * It lives in the shared package on purpose: the Preferences screen shows the
 * LITERAL text that goes into the prompt ("see the exact text"), so the source is a
 * single one — if the text lived only in prompts.ts, the screen would display a copy that
 * ages at the first change.
 *
 * Behavior is not memory. Nothing here is learned by the agent: the style is
 * chosen, the adjustment is written by the user, and the mirroring of the register
 * happens in the conversation, without recording anything.
 */

/** Styles offered. `default` = no style instruction (the usual tone). */
export type PersonaStyle = 'default' | 'direct' | 'mentor' | 'technical'

/**
 * Ceiling of the free adjustment. Short enough to be a complement to the style —
 * if it fits in a briefing, it has become a prompt, and a hand-editable prompt is what the
 * screen avoids.
 */
export const PERSONA_NOTE_MAX = 400

/**
 * Text of each style (in English, like the rest of the prompt). The description the
 * user reads on the screen is another one, translated — this one is what the model receives.
 */
export const PERSONA_STYLE_PROMPTS: Record<Exclude<PersonaStyle, 'default'>, string> = {
  direct:
    'Be terse: answer first, explanation only when it changes what the user does with it. ' +
    'No "sure", no "happy to help", no closing summary of what you just said.',
  mentor:
    'Teach while you solve: say why a choice was made and point out what the user did not ask about ' +
    'but will run into. Still no filler.',
  technical:
    'Stay precise and neutral: exact terms, visible structure, no colloquialisms and no humour.',
}

/**
 * Calibrated mirroring — it goes into `identity()`, applying in both modes even
 * without a chosen style. It is what makes the agent follow the register of the
 * conversation (what people perceive as "it learned to talk like me"), with
 * two brakes: never more informal than the user, and form yes, opinion no.
 */
export const PERSONA_MIRROR =
  "Match the user's register and language level: if they write informally, do the same; never be " +
  'more informal than they are — and when the work is code, keep the register professional, mirroring ' +
  'only concision and directness. Mirror form, never opinions — agreeing is not style.'

/**
 * Lines injected into the system prompt. Empty when there is neither style nor adjustment:
 * without a user choice, the prompt stays exactly as it was before.
 */
export function personaPromptLines(
  style: PersonaStyle,
  note: string,
  mode: 'chat' | 'code',
): string[] {
  const lines: string[] = []
  if (style !== 'default') lines.push(PERSONA_STYLE_PROMPTS[style])
  const trimmed = note.trim()
  if (trimmed) {
    // The order matters: what the user wrote beats the box he ticked.
    lines.push(
      `The user wrote this about how you should talk — it takes precedence over the style above: ${trimmed}`,
    )
  }
  if (!lines.length) return []
  // In code the register stays professional: the style yields concision and
  // directness, not colloquialism.
  if (mode === 'code') {
    lines.push('In code mode keep the register professional: apply only concision and directness.')
  }
  return [`HOW TO TALK. ${lines.join(' ')}`]
}
