/**
 * Como o Orbit fala (Preferências → Comportamento).
 *
 * Vive no pacote compartilhado de propósito: a tela de Preferências mostra o
 * texto LITERAL que vai no prompt ("ver o texto exato"), então a fonte é uma
 * só — se o texto morasse apenas no prompts.ts, a tela exibiria uma cópia que
 * envelhece na primeira mudança.
 *
 * Comportamento não é memória. Nada aqui é aprendido pelo agente: o estilo é
 * escolhido, o ajuste é escrito pelo usuário, e o espelhamento do registro
 * acontece na conversa, sem gravar nada.
 */

/** Estilos oferecidos. `default` = sem instrução de estilo (o tom de sempre). */
export type PersonaStyle = 'default' | 'direct' | 'mentor' | 'technical'

/**
 * Teto do ajuste livre. Curto o bastante para ser um complemento ao estilo —
 * se couber num briefing, virou prompt, e prompt editável à mão é o que a
 * tela evita.
 */
export const PERSONA_NOTE_MAX = 400

/**
 * Texto de cada estilo (em inglês, como o resto do prompt). A descrição que o
 * usuário lê na tela é outra, traduzida — esta aqui é a que o modelo recebe.
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
 * Espelhamento calibrado — vai no `identity()`, valendo nos dois modos mesmo
 * sem estilo escolhido. É o que faz o agente acompanhar o registro da
 * conversa (o que as pessoas percebem como "aprendeu a falar como eu"), com
 * dois freios: nunca mais informal que o usuário, e forma sim, opinião não.
 */
export const PERSONA_MIRROR =
  "Match the user's register and language level: if they write informally, do the same; never be " +
  'more informal than they are — and when the work is code, keep the register professional, mirroring ' +
  'only concision and directness. Mirror form, never opinions — agreeing is not style.'

/**
 * Linhas injetadas no system prompt. Vazio quando não há estilo nem ajuste:
 * sem escolha do usuário, o prompt fica exatamente como era antes.
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
    // A ordem importa: o que o usuário escreveu vence a caixinha que ele marcou.
    lines.push(
      `The user wrote this about how you should talk — it takes precedence over the style above: ${trimmed}`,
    )
  }
  if (!lines.length) return []
  // No código o registro continua profissional: o estilo rende concisão e
  // diretude, não coloquialismo.
  if (mode === 'code') {
    lines.push('In code mode keep the register professional: apply only concision and directness.')
  }
  return [`HOW TO TALK. ${lines.join(' ')}`]
}
