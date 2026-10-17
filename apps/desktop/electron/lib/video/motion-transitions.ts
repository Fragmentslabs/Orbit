/**
 * TRANSIÇÕES de uma composição de motion: a troca de uma cena por outra (ou a
 * entrada/saída de uma só) como um ato da própria peça, e não como animação
 * escrita à mão a cada vez.
 *
 * A composição declara — `orbitMotion.transition({ out, in, at, duration, type })`
 * — e o runtime transforma isso em animações Web Animations PAUSADAS, uma por
 * elemento. É o que as faz determinísticas sem código novo no caminho do quadro:
 * o `applyFrame` do runtime já posiciona TODO `document.getAnimations()` em
 * `t * 1000`, então a transição é buscada exatamente como um @keyframes — no
 * preview, na medição de camadas e no render. Nada de timer, nada de estado entre
 * quadros: o progresso em `t` é função pura de `t`.
 *
 * As animações só usam propriedades que COMPÕEM com o que a composição já
 * escreveu (`translate` e `scale` individuais, que não pisam no `transform`;
 * `opacity`, `filter`, `clip-path`) e deixam o elemento como estava fora do
 * intervalo: a entrada usa `fill: backwards` (escondida até `at`, solta depois) e
 * a saída `fill: forwards` (escondida depois do fim).
 *
 * Este módulo é só o CÉREBRO, em JS de página: validar o pedido e montar os
 * keyframes. A string é embutida no runtime (que roda na janela, sem import) e
 * os testes a executam direto — nenhum DOM é necessário para checá-la.
 */

/** Os tipos de transição que o runtime sabe montar. */
export const MOTION_TRANSITION_TYPES = ['fade', 'push', 'cover', 'reveal', 'wipe', 'zoom', 'blur', 'iris'] as const
export type MotionTransitionType = (typeof MOTION_TRANSITION_TYPES)[number]

/** Para onde o movimento vai. `in`/`out` valem só para o zoom. */
export type MotionTransitionDirection = 'left' | 'right' | 'up' | 'down' | 'in' | 'out'

/** O que o runtime anuncia de cada transição registrada (lint e relatório). */
export interface MotionTransitionInfo {
  type: MotionTransitionType
  direction: MotionTransitionDirection | null
  /** Segundo da peça em que começa. */
  at: number
  duration: number
  /** Como a composição chamou cada ponta (seletor ou etiqueta); null = ausente. */
  out: string | null
  in: string | null
}

/**
 * O script. Sem crases, sem `${` e sem barra invertida DE PROPÓSITO: ele é
 * interpolado dentro do template do runtime, onde qualquer um deles viraria
 * outra coisa.
 */
export const MOTION_TRANSITIONS_SCRIPT = `
  const ORBIT_TRANSITION_TYPES = ${JSON.stringify(MOTION_TRANSITION_TYPES)}
  const ORBIT_TRANSITION_VECTORS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }
  // O que está TOTALMENTE escondido em cada direção do wipe (insets do clip-path):
  // a entrada começa assim, e a saída termina no inset do lado oposto.
  const ORBIT_WIPE_HIDDEN = {
    left: '0% 0% 0% 100%',
    right: '0% 100% 0% 0%',
    up: '100% 0% 0% 0%',
    down: '0% 0% 100% 0%',
  }
  const ORBIT_WIPE_OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' }
  const ORBIT_EASING_WORDS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']

  function orbitValidEasing(value) {
    if (ORBIT_EASING_WORDS.indexOf(value) >= 0) return true
    const call = value.indexOf('cubic-bezier(') === 0 || value.indexOf('steps(') === 0
    return call && value.charAt(value.length - 1) === ')' && value.indexOf(';') < 0
  }

  // Valida o pedido e preenche os padrões. Devolve { spec } ou { error } — nunca
  // lança: quem chama decide se o erro derruba a composição.
  function orbitNormalizeTransition(raw) {
    if (!raw || typeof raw !== 'object') return { error: 'expected an object like { out, in, at, duration, type }' }
    if (!raw.out && !raw.in) return { error: 'give at least one of "out" (leaving) and "in" (entering)' }
    const type = raw.type === undefined ? 'fade' : String(raw.type)
    if (ORBIT_TRANSITION_TYPES.indexOf(type) < 0) {
      return { error: 'unknown type "' + type + '" (use ' + ORBIT_TRANSITION_TYPES.join(', ') + ')' }
    }
    // Fade, blur e iris não têm lado: a direção, se vier, é ignorada.
    let direction = null
    if (type === 'zoom') {
      direction = raw.direction === undefined ? 'in' : String(raw.direction)
      if (direction !== 'in' && direction !== 'out') return { error: 'zoom takes direction "in" or "out"' }
    } else if (type !== 'fade' && type !== 'blur' && type !== 'iris') {
      direction = raw.direction === undefined ? 'left' : String(raw.direction)
      if (!ORBIT_TRANSITION_VECTORS[direction]) {
        return { error: type + ' takes direction left, right, up or down (got "' + direction + '")' }
      }
    }
    if (typeof raw.at !== 'number' || !isFinite(raw.at) || raw.at < 0) {
      return { error: '"at" (the second the transition starts, >= 0) is required' }
    }
    const duration = raw.duration === undefined ? 0.6 : raw.duration
    if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0 || duration > 30) {
      return { error: '"duration" must be a number of seconds between 0 and 30' }
    }
    const easing = raw.easing === undefined ? 'ease-in-out' : String(raw.easing)
    if (!orbitValidEasing(easing)) {
      return { error: 'easing "' + easing + '" is not linear, ease, ease-in, ease-out, ease-in-out, cubic-bezier(…) or steps(…)' }
    }
    let amount
    if (raw.amount !== undefined) {
      if (typeof raw.amount !== 'number' || !isFinite(raw.amount) || raw.amount <= 0) {
        return { error: '"amount" must be a positive number' }
      }
      amount = raw.amount
    }
    return { spec: { type: type, direction: direction, at: raw.at, duration: duration, easing: easing, amount: amount } }
  }

  function orbitPct(n) { return (Math.round(n * 10000) / 100) + '%' }
  function orbitShift(x, y) { return orbitPct(x) + ' ' + orbitPct(y) }

  // Os keyframes de cada ponta: { out, in }. A visibilidade vai em TODA ponta —
  // é ela que esconde a entrada até o começo e a saída depois do fim, sem tocar no
  // que a composição escreveu para o elemento.
  function orbitTransitionKeyframes(spec) {
    const dir = spec.direction
    const v = ORBIT_TRANSITION_VECTORS[dir] || [0, 0]
    const rest = orbitShift(0, 0)
    const outShown = { visibility: 'visible' }
    const outGone = { visibility: 'hidden' }
    const inHidden = { visibility: 'hidden' }
    const inShown = { visibility: 'visible' }
    const mix = function (a, b) { return Object.assign({}, a, b) }
    switch (spec.type) {
      case 'push':
        return {
          out: [mix(outShown, { translate: rest }), mix(outGone, { translate: orbitShift(v[0], v[1]) })],
          in: [mix(inHidden, { translate: orbitShift(-v[0], -v[1]) }), mix(inShown, { translate: rest })],
        }
      case 'cover':
        // A entrada desliza POR CIMA de uma saída que quase não se mexe (um quarto
        // do caminho: a profundidade). Exige que a entrada esteja acima no empilhamento.
        return {
          out: [mix(outShown, { translate: rest }), mix(outGone, { translate: orbitShift(v[0] * 0.25, v[1] * 0.25) })],
          in: [mix(inHidden, { translate: orbitShift(-v[0], -v[1]) }), mix(inShown, { translate: rest })],
        }
      case 'reveal':
        // O oposto: a saída escorrega para fora e descobre uma entrada que já
        // estava lá embaixo. Exige que a saída esteja acima.
        return {
          out: [mix(outShown, { translate: rest }), mix(outGone, { translate: orbitShift(v[0], v[1]) })],
          in: [mix(inHidden, { translate: orbitShift(-v[0] * 0.25, -v[1] * 0.25) }), mix(inShown, { translate: rest })],
        }
      case 'wipe': {
        // Os dois lados são recortados em partes COMPLEMENTARES, então a ordem de
        // empilhamento não importa: onde a entrada aparece, a saída já foi.
        const full = 'inset(0% 0% 0% 0%)'
        return {
          out: [
            mix(outShown, { clipPath: full }),
            mix(outGone, { clipPath: 'inset(' + ORBIT_WIPE_HIDDEN[ORBIT_WIPE_OPPOSITE[dir]] + ')' }),
          ],
          in: [mix(inHidden, { clipPath: 'inset(' + ORBIT_WIPE_HIDDEN[dir] + ')' }), mix(inShown, { clipPath: full })],
        }
      }
      case 'zoom': {
        const a = Math.min(spec.amount === undefined ? 0.25 : spec.amount, 1)
        const grow = 1 + a
        const shrink = 1 - a * 0.8
        const zoomIn = dir !== 'out'
        return {
          out: [
            mix(outShown, { scale: '1', opacity: '1' }),
            mix(outGone, { scale: String(zoomIn ? grow : shrink), opacity: '0' }),
          ],
          in: [
            mix(inHidden, { scale: String(zoomIn ? shrink : grow), opacity: '0' }),
            mix(inShown, { scale: '1', opacity: '1' }),
          ],
        }
      }
      case 'blur': {
        const px = (spec.amount === undefined ? 24 : spec.amount) + 'px'
        return {
          out: [mix(outShown, { filter: 'blur(0px)', opacity: '1' }), mix(outGone, { filter: 'blur(' + px + ')', opacity: '0' })],
          in: [mix(inHidden, { filter: 'blur(' + px + ')', opacity: '0' }), mix(inShown, { filter: 'blur(0px)', opacity: '1' })],
        }
      }
      case 'iris':
        // 75% do raio de referência cobre o canto mais distante de qualquer
        // proporção. A saída só some no fim: a entrada, acima, a vai cobrindo.
        return {
          out: [outShown, outGone],
          in: [
            mix(inHidden, { clipPath: 'circle(0% at 50% 50%)' }),
            mix(inShown, { clipPath: 'circle(75% at 50% 50%)' }),
          ],
        }
      default:
        return {
          out: [mix(outShown, { opacity: '1' }), mix(outGone, { opacity: '0' })],
          in: [mix(inHidden, { opacity: '0' }), mix(inShown, { opacity: '1' })],
        }
    }
  }
`

/** Forma que o script devolve — a mesma que os testes e o lint esperam. */
export interface NormalizedTransition {
  type: MotionTransitionType
  direction: MotionTransitionDirection | null
  at: number
  duration: number
  easing: string
  amount?: number
}

/** Uma linha por transição para o relatório que o agente lê (tempo da PEÇA, em segundos). */
export function describeTransitions(transitions: MotionTransitionInfo[]): string {
  if (transitions.length === 0) return ''
  const sec = (n: number) => `${Number(n.toFixed(2))}s`
  return `Transitions: ${transitions
    .map((t) => {
      const side = [t.out ? `out ${t.out}` : '', t.in ? `in ${t.in}` : ''].filter(Boolean).join(', ')
      return `${t.type}${t.direction ? ` ${t.direction}` : ''} ${sec(t.at)}→${sec(t.at + t.duration)} (${side})`
    })
    .join('; ')}.`
}
