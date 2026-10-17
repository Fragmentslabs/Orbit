import type { MotionAudioPlan } from './motion-audio'
import type { MotionTransitionInfo } from './motion-transitions'

/**
 * O LINT de uma composição de motion: o que dá para dizer sobre ela ANTES de
 * pagar um render — e antes de o usuário descobrir pelo vídeo.
 *
 * O contrato do Orbit é um só: o quadro N é uma função pura de N. Quase todo
 * defeito caro de uma composição é uma quebra dele, e quase todas se enxergam no
 * texto: um relógio de parede (`Date.now()`), um sorteio sem semente
 * (`Math.random()`), um timer que anda sozinho, uma transição CSS que só dispara
 * numa mudança de classe, um arquivo que não está ao lado do HTML. Cada regra
 * abaixo nasceu de uma dessas falhas e diz o que fazer no lugar.
 *
 * Três fontes, três funções puras (testáveis sem janela e sem disco):
 *  - `lintMotionSources`: o HTML de entrada e os scripts locais dele;
 *  - `lintMotionAudio`: o manifest de áudio contra o comprimento da peça;
 *  - `lintMotionTransitions`: o que a composição registrou em runtime.
 *
 * Severidade: `error` é uma composição que vai sair ERRADA (ou nem sair);
 * `warning` é suspeita — pode ser intencional, mas merece olhar. Nada aqui
 * bloqueia um render: o relatório é informação para quem escreve a peça.
 */

export type LintSeverity = 'error' | 'warning'

export interface LintFinding {
  rule: string
  severity: LintSeverity
  message: string
  /** O que fazer no lugar. */
  hint?: string
  /** Linha no arquivo (1-based), quando a regra sabe apontar. */
  line?: number
  /** Arquivo, quando não é o de entrada. */
  file?: string
}

/** Um arquivo de texto da composição. */
export interface LintSource {
  name: string
  text: string
}

/** O que há por trás de uma referência relativa (`src`, `url(...)`). */
export type AssetStatus = 'ok' | 'missing' | 'outside'

export interface LintSourceOptions {
  /** Confere uma referência relativa contra a pasta da composição. */
  assetStatus?: (ref: string) => AssetStatus
}

// ----------------------------------------------------------------- máscaras

/**
 * O JS sem comentários e sem o CONTEÚDO das strings (as aspas ficam). Mantém os
 * tamanhos e as quebras de linha, então um índice no resultado é o mesmo índice
 * no original — é isso que permite apontar a linha. Evita o falso positivo
 * clássico: `"Math.random()"` num texto, ou `// Date.now() não!` num comentário.
 */
export function maskJs(source: string): string {
  let out = ''
  let i = 0
  const blank = (ch: string) => (ch === '\n' || ch === '\r' ? ch : ' ')
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out += blank(source[i++])
    } else if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) out += blank(source[i++])
      if (i < source.length) {
        out += '  '
        i += 2
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      out += ch
      i++
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\' && i + 1 < source.length) {
          out += ' '
          i++
        }
        // Uma string simples não atravessa linha: se atravessar, o laço de quem
        // mascara teria virado o arquivo inteiro numa string por causa de uma
        // regex com aspas. Fecha ali e segue.
        if (ch !== '`' && source[i] === '\n') break
        out += blank(source[i++])
      }
      if (i < source.length && source[i] === ch) out += source[i++]
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** O CSS sem comentários, nos mesmos tamanhos. */
function maskCss(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n\r]/g, ' '))
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

// ------------------------------------------------------------------- regras

interface Rule {
  rule: string
  severity: LintSeverity
  pattern: RegExp
  message: (match: string) => string
  hint: string
  /** Descarta o achado quando devolve true (a regra não cabe no contexto). */
  skip?: (match: RegExpExecArray) => boolean
}

const JS_RULES: Rule[] = [
  {
    rule: 'wall-clock',
    severity: 'error',
    pattern: /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(/g,
    message: (m) => `${m.trim()} reads the wall clock — the frame would depend on WHEN it is rendered`,
    hint: 'derive time from the frame: const t = frame / window.orbitMotion.fps',
  },
  {
    rule: 'random',
    severity: 'error',
    pattern: /\bMath\.random\s*\(/g,
    message: () => 'Math.random() gives a different frame every render (and a different one per parallel band)',
    hint: 'use a seeded generator keyed by the element index (e.g. mulberry32(i)) so frame N always draws the same',
  },
  {
    rule: 'interval',
    severity: 'error',
    pattern: /\bsetInterval\s*\(/g,
    message: () => 'setInterval() advances on wall-clock time; the seek never runs it',
    hint: 'animate from the frame (orbitMotion.seek, a GSAP timeline, @keyframes or orbitMotion.transition)',
  },
  {
    rule: 'timer',
    severity: 'warning',
    pattern: /\bsetTimeout\s*\(|\brequestAnimationFrame\s*\(/g,
    message: (m) => `${m.trim()} runs on wall-clock time — fine to wait for a load, wrong to move something`,
    hint: 'to wait for an asset use delayRender()/continueRender(); to animate, key it to the frame',
  },
  {
    rule: 'endless-loop',
    severity: 'warning',
    pattern: /\brepeat\s*:\s*-1\b/g,
    message: () => 'repeat: -1 never ends, so the timeline has no length of its own',
    hint: 'repeat a fixed number of times, or declare the length in <meta name="orbit-motion" content="duration=…">',
  },
  {
    rule: 'page-audio',
    severity: 'warning',
    pattern: /\bnew\s+Audio\s*\(/g,
    message: () => 'sound played by the page is not captured in the render',
    hint: 'declare the track in audio.json next to index.html',
  },
  {
    rule: 'network-call',
    severity: 'warning',
    pattern: /\b(?:fetch\s*\(|new\s+XMLHttpRequest\b)/g,
    message: () => 'loading data over the network at render time can differ between runs (or fail offline)',
    hint: 'save the data next to index.html and load it by relative path inside delayRender()/continueRender()',
  },
]

const CSS_RULES: Rule[] = [
  {
    rule: 'css-transition',
    severity: 'warning',
    pattern: /(?<![-\w])transition(?:-property)?\s*:\s*([^;}]*)/g,
    skip: (m) => /^\s*(?:none|initial|unset)\b/.test(m[1]),
    message: () => 'a CSS transition starts when a style CHANGES, on wall-clock time — the seek cannot reproduce it',
    hint: 'use @keyframes / the Web Animations API, or orbitMotion.transition({ out, in, at, duration })',
  },
  {
    rule: 'endless-loop',
    severity: 'warning',
    pattern: /animation(?:-iteration-count)?\s*:[^;}]*\binfinite\b/g,
    message: () => 'an infinite CSS animation has no length of its own',
    hint: 'give it a finite iteration count that fits the piece, or declare the length in the <meta>',
  },
  {
    rule: 'viewport-units',
    severity: 'warning',
    pattern: /(?<![\w.-])-?\d*\.?\d+(?:vw|vh|vmin|vmax|svh|lvh|dvh)\b/g,
    message: (m) => `${m.trim()} depends on the window, but a composition has its OWN fixed size`,
    hint: 'use px against the declared width/height — the tab scales the whole document, it does not resize it',
  },
]

/** Atributos que apontam para arquivo, por tag. */
const ASSET_ATTRIBUTES = /<(script|link|img|video|audio|source|image|iframe|embed|object)\b([^>]*)>/gi
const ATTRIBUTE = /\b(src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi
/** O que a regra de rede aceita sem reclamar: o contrato do guia permite Google Fonts. */
const ALLOWED_REMOTE = /^(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com\//i

function isRemote(ref: string): boolean {
  return /^(?:https?:)?\/\//i.test(ref)
}

/** Referência para um arquivo local (nem URL, nem âncora, nem data:). */
function isLocalRef(ref: string): boolean {
  const value = ref.trim()
  if (!value || value.startsWith('#') || isRemote(value)) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
}

interface Block {
  text: string
  /** Onde o bloco começa no arquivo, para calcular a linha. */
  offset: number
}

/** Os blocos `<script>` sem `src` e `<style>` do HTML. */
function htmlBlocks(html: string): { scripts: Block[]; styles: Block[]; remoteScripts: string[] } {
  const scripts: Block[] = []
  const styles: Block[] = []
  const remoteScripts: string[] = []
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n\r]/g, ' '))
  for (const m of withoutComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1]
    if (/\bsrc\s*=/i.test(attrs)) {
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
      if (src) remoteScripts.push(src[1] ?? src[2] ?? src[3])
      continue
    }
    // JSON de dados e módulos de template não são código da composição.
    if (/\btype\s*=\s*["']?(?:application\/json|application\/ld\+json|text\/template)/i.test(attrs)) continue
    scripts.push({ text: m[2], offset: (m.index ?? 0) + m[0].indexOf(m[2], m[1].length) })
  }
  for (const m of withoutComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    styles.push({ text: m[1], offset: (m.index ?? 0) + m[0].indexOf(m[1]) })
  }
  return { scripts, styles, remoteScripts }
}

function runRules(rules: Rule[], masked: string, base: number, whole: string, file?: string): LintFinding[] {
  const out: LintFinding[] = []
  for (const r of rules) {
    r.pattern.lastIndex = 0
    for (let m = r.pattern.exec(masked); m; m = r.pattern.exec(masked)) {
      if (m[0].length === 0) r.pattern.lastIndex++
      if (r.skip?.(m)) continue
      out.push({
        rule: r.rule,
        severity: r.severity,
        message: r.message(m[0]),
        hint: r.hint,
        line: lineAt(whole, base + m.index),
        ...(file ? { file } : {}),
      })
    }
  }
  return out
}

/** Junta achados repetidos da mesma regra numa linha só (`also at lines …`). */
function collapse(findings: LintFinding[]): LintFinding[] {
  const byKey = new Map<string, LintFinding & { more: number[] }>()
  const order: string[] = []
  for (const f of findings) {
    const key = `${f.file ?? ''}|${f.rule}|${f.message}`
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, { ...f, more: [] })
      order.push(key)
    } else if (f.line !== undefined) {
      seen.more.push(f.line)
    }
  }
  return order.map((key) => {
    const { more, ...f } = byKey.get(key)!
    return more.length > 0 ? { ...f, message: `${f.message} (also at line${more.length > 1 ? 's' : ''} ${more.slice(0, 5).join(', ')})` } : f
  })
}

export interface AssetRef {
  ref: string
  line: number
  /** `script`, `img`, `css`… — só para a mensagem. */
  tag: string
}

/** Toda referência a arquivo do HTML: atributos de tag, `url(...)` e `@import` do CSS. */
export function collectAssetRefs(html: string): AssetRef[] {
  const refs: AssetRef[] = []
  const stripped = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n\r]/g, ' '))
  for (const tag of stripped.matchAll(ASSET_ATTRIBUTES)) {
    for (const attr of tag[2].matchAll(ATTRIBUTE)) {
      const ref = (attr[2] ?? attr[3] ?? attr[4] ?? '').trim()
      const name = attr[1].toLowerCase()
      // <link rel="canonical"> e afins apontam para a web, não para um arquivo da peça.
      if (name === 'href' && tag[1].toLowerCase() === 'link' && /rel\s*=\s*["']?(?:canonical|alternate|author|help)/i.test(tag[2])) continue
      refs.push({ ref, line: lineAt(html, (tag.index ?? 0) + tag[0].indexOf(attr[0])), tag: tag[1].toLowerCase() })
    }
  }
  for (const block of htmlBlocks(html).styles) {
    for (const m of maskCss(block.text).matchAll(CSS_URL)) {
      const ref = (m[1] ?? m[2] ?? m[3] ?? '').trim()
      if (ref) refs.push({ ref, line: lineAt(html, block.offset + (m.index ?? 0)), tag: 'css' })
    }
    for (const m of block.text.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) {
      refs.push({ ref: m[1], line: lineAt(html, block.offset + (m.index ?? 0)), tag: 'css' })
    }
  }
  return refs
}

/** Os `src` de `<script>` que apontam para arquivo da pasta (nem URL, nem data:). */
export function localScriptRefs(html: string): string[] {
  return collectAssetRefs(html)
    .filter((r) => r.tag === 'script' && isLocalRef(r.ref))
    .map((r) => r.ref)
}

/**
 * O HTML de entrada e os scripts locais dele. `scripts` são os arquivos .js
 * AUTORAIS da pasta — bibliotecas (`*.min.js`) ficam de fora quem monta a lista.
 */
export function lintMotionSources(entry: LintSource, scripts: LintSource[] = [], options: LintSourceOptions = {}): LintFinding[] {
  const findings: LintFinding[] = []
  const html = entry.text
  const { scripts: inline, styles, remoteScripts } = htmlBlocks(html)

  let animated = false
  const signals = [/\bseek\b/, /\bgsap\b/, /\borbitTimeline\b/, /@keyframes/, /\.animate\s*\(/, /\borbitMotion\s*\.\s*transition\b/, /<video\b/i]

  for (const block of inline) {
    const masked = maskJs(block.text)
    findings.push(...runRules(JS_RULES, masked, block.offset, html))
    if (signals.some((s) => s.test(masked))) animated = true
  }
  for (const block of styles) {
    const masked = maskCss(block.text)
    findings.push(...runRules(CSS_RULES, masked, block.offset, html))
    if (signals.some((s) => s.test(masked))) animated = true
  }
  // `style="…"` em linha: só a regra de unidades de viewport e a de transição.
  for (const m of html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) {
    const offset = (m.index ?? 0) + m[0].indexOf(m[1])
    findings.push(...runRules(CSS_RULES, maskCss(m[1]), offset, html))
  }
  for (const script of scripts) {
    const masked = maskJs(script.text)
    findings.push(...runRules(JS_RULES, masked, 0, script.text, script.name))
    if (signals.some((s) => s.test(masked))) animated = true
  }
  // Um script externo (gsap, three) ou um <video> também anima.
  if (remoteScripts.some((src) => /gsap|anime|lottie|three/i.test(src))) animated = true
  if (/<video\b/i.test(html)) animated = true

  // ----------------------------------------------- tags de áudio na página
  if (/<audio\b/i.test(html.replace(/<!--[\s\S]*?-->/g, ''))) {
    findings.push({
      rule: 'page-audio',
      severity: 'warning',
      message: 'an <audio> element is not captured in the render — only the tracks declared in audio.json are mixed',
      hint: 'move the file next to index.html and declare it in audio.json',
      line: lineAt(html, html.search(/<audio\b/i)),
    })
  }

  // -------------------------------------------- arquivos e rede (atributos)
  const refs = collectAssetRefs(html)
  const seenRefs = new Set<string>()
  for (const { ref, line, tag } of refs) {
    const key = `${ref}|${line}`
    if (seenRefs.has(key) || !ref) continue
    seenRefs.add(key)
    if (isRemote(ref)) {
      if (ALLOWED_REMOTE.test(ref)) continue
      findings.push({
        rule: 'remote-resource',
        severity: 'warning',
        message: `${ref} is loaded from the network — the piece does not render (or animate) offline`,
        hint: 'download the file next to index.html and reference it by relative path',
        line,
      })
    } else if (isLocalRef(ref) && options.assetStatus) {
      const status = options.assetStatus(ref)
      if (status === 'missing') {
        findings.push({
          rule: 'missing-asset',
          severity: 'error',
          message: `${ref} (${tag}) does not exist in the composition folder`,
          hint: 'copy the file next to index.html, or fix the path',
          line,
        })
      } else if (status === 'outside') {
        findings.push({
          rule: 'asset-outside-folder',
          severity: 'error',
          message: `${ref} (${tag}) points outside the composition folder, which the preview never serves`,
          hint: 'copy the file into the folder and reference it by a path inside it',
          line,
        })
      }
    }
  }

  if (!animated) {
    findings.push({
      rule: 'static-piece',
      severity: 'warning',
      message: 'nothing in this composition changes over time (no seek, timeline, @keyframes, .animate() or transition)',
      hint: 'if it is meant to move, animate from the frame; a still title card is fine as it is',
    })
  }

  return collapse(findings)
}

// -------------------------------------------------------------------- áudio

const at = (seconds: number): string => `${Number(seconds.toFixed(2))}s`

/** O manifest de áudio contra o comprimento da peça, em segundos. */
export function lintMotionAudio(plan: MotionAudioPlan, durationSeconds: number): LintFinding[] {
  const out: LintFinding[] = []
  const { tracks, master } = plan
  for (const track of tracks) {
    const label = `audio "${track.name}"`
    if (track.start >= durationSeconds) {
      out.push({
        rule: 'audio-after-end',
        severity: 'error',
        message: `${label} starts at ${at(track.start)} but the piece ends at ${at(durationSeconds)} — it is never heard`,
        hint: 'move "start" earlier, or make the piece longer',
      })
      continue
    }
    const span = (track.end ?? durationSeconds) - track.start
    if (track.fadeIn + track.fadeOut > span + 0.001) {
      out.push({
        rule: 'audio-fades-overlap',
        severity: 'warning',
        message: `${label}: the fades (${at(track.fadeIn)} in + ${at(track.fadeOut)} out) are longer than the ${at(span)} it plays`,
        hint: 'shorten the fades — as written the track never reaches full level',
      })
    }
    if (track.gainDb > 6 && master?.limit === undefined) {
      out.push({
        rule: 'audio-hot',
        severity: 'warning',
        message: `${label} is boosted by ${track.gainDb} dB with no limiter on the mix — it can clip`,
        hint: 'lower the gain, or add "master": { "limit": -1 } to audio.json',
      })
    }
    for (const point of track.fx.automation) {
      if (point.at > durationSeconds) {
        out.push({
          rule: 'audio-automation-late',
          severity: 'warning',
          message: `${label}: a volume point at ${at(point.at)} is past the end of the piece (${at(durationSeconds)})`,
          hint: 'automation times are seconds on the PIECE, not on the file',
        })
        break
      }
    }
  }
  const beds = tracks.filter((t) => t.duck)
  if (beds.length > 0 && beds.length === tracks.length) {
    out.push({
      rule: 'audio-duck-alone',
      severity: 'warning',
      message: 'every track is a "duck" bed, so there is no voice or effect for it to step back for',
      hint: 'duck only the music under a narration or effect; leave the others without "duck"',
    })
  }
  return out
}

// --------------------------------------------------------------- transições

/** O que a composição registrou em runtime contra o comprimento da peça. */
export function lintMotionTransitions(transitions: MotionTransitionInfo[], durationSeconds: number): LintFinding[] {
  const out: LintFinding[] = []
  const name = (t: MotionTransitionInfo) =>
    `${t.type}${t.direction ? ` ${t.direction}` : ''} at ${at(t.at)} (${[t.out, t.in].filter(Boolean).join(' → ')})`
  for (const t of transitions) {
    if (t.at >= durationSeconds) {
      out.push({
        rule: 'transition-after-end',
        severity: 'error',
        message: `transition ${name(t)} starts after the piece ends (${at(durationSeconds)}) — it never plays`,
        hint: 'move "at" earlier, or make the piece longer',
      })
    } else if (t.at + t.duration > durationSeconds + 0.001) {
      out.push({
        rule: 'transition-cut-off',
        severity: 'warning',
        message: `transition ${name(t)} runs ${at(t.at + t.duration - durationSeconds)} past the end of the piece — it is cut off`,
        hint: 'shorten "duration" or start it earlier so it finishes inside the piece',
      })
    }
  }
  // Duas transições sobre o mesmo elemento ao mesmo tempo disputam as mesmas
  // propriedades: a que foi registrada por último vence, e a outra some.
  for (let i = 0; i < transitions.length; i++) {
    for (let j = i + 1; j < transitions.length; j++) {
      const a = transitions[i]
      const b = transitions[j]
      const shared = [a.out, a.in].filter((x): x is string => !!x).filter((x) => x === b.out || x === b.in)
      if (shared.length === 0) continue
      if (a.at < b.at + b.duration && b.at < a.at + a.duration) {
        out.push({
          rule: 'transition-overlap',
          severity: 'warning',
          message: `${shared[0]} is in two transitions at once: ${name(a)} and ${name(b)}`,
          hint: 'the later one wins on shared properties — make them follow each other instead',
        })
      }
    }
  }
  return out
}

// ----------------------------------------------------------------- relatório

export function lintCounts(findings: LintFinding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  }
}

const MAX_REPORTED = 12

/** O relatório que o agente lê: erros primeiro, cada um com o que fazer. */
export function describeLint(findings: LintFinding[]): string {
  if (findings.length === 0) return 'Lint: clean.'
  const { errors, warnings } = lintCounts(findings)
  const ordered = [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  const lines = ordered.slice(0, MAX_REPORTED).map((f) => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : f.line ? `line ${f.line}` : ''
    return `- [${f.severity}] ${f.rule}${where ? ` (${where})` : ''}: ${f.message}${f.hint ? ` → ${f.hint}` : ''}`
  })
  const hidden = ordered.length - lines.length
  return [
    `Lint: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`,
    ...lines,
    hidden > 0 ? `- … and ${hidden} more.` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
