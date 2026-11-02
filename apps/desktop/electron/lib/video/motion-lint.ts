import type { MotionAudioPlan } from './motion-audio'
import type { MotionTransitionInfo } from './motion-transitions'

/**
 * The LINT of a motion composition: what can be said about it BEFORE
 * paying for a render — and before the user finds out from the video.
 *
 * Orbit's contract is one: frame N is a pure function of N. Almost every
 * expensive defect of a composition is a break of it, and almost all of them can be seen in
 * the text: a wall clock (`Date.now()`), a draw without a seed
 * (`Math.random()`), a timer that runs on its own, a CSS transition that only fires
 * on a class change, a file that is not next to the HTML. Each rule
 * below was born from one of those failures and says what to do instead.
 *
 * Three sources, three pure functions (testable without a window and without disk):
 *  - `lintMotionSources`: the entry HTML and its local scripts;
 *  - `lintMotionAudio`: the audio manifest against the length of the piece;
 *  - `lintMotionTransitions`: what the composition registered at runtime.
 *
 * Severity: `error` is a composition that will come out WRONG (or not come out at all);
 * `warning` is suspicion — it may be intentional, but it deserves a look. Nothing here
 * blocks a render: the report is information for whoever writes the piece.
 */

export type LintSeverity = 'error' | 'warning'

export interface LintFinding {
  rule: string
  severity: LintSeverity
  message: string
  /** What to do instead. */
  hint?: string
  /** Line in the file (1-based), when the rule can point to it. */
  line?: number
  /** File, when it is not the entry one. */
  file?: string
}

/** A text file of the composition. */
export interface LintSource {
  name: string
  text: string
}

/** What lies behind a relative reference (`src`, `url(...)`). */
export type AssetStatus = 'ok' | 'missing' | 'outside'

export interface LintSourceOptions {
  /** Checks a relative reference against the composition's folder. */
  assetStatus?: (ref: string) => AssetStatus
}

// ----------------------------------------------------------------- masks

/**
 * The JS without comments and without the CONTENT of strings (the quotes stay). It keeps
 * the lengths and the line breaks, so an index in the result is the same index
 * in the original — that is what allows pointing to the line. It avoids the classic
 * false positive: `"Math.random()"` in a text, or `// Date.now() is not it!` in a comment.
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
        // A single-quoted string does not cross lines: if it does, the loop of whoever
        // masks would have turned the whole file into a string because of a
        // regex with quotes. Closes there and moves on.
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

/** The CSS without comments, at the same lengths. */
function maskCss(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n\r]/g, ' '))
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

// ------------------------------------------------------------------- rules

interface Rule {
  rule: string
  severity: LintSeverity
  pattern: RegExp
  message: (match: string) => string
  hint: string
  /** Discards the finding when it returns true (the rule does not fit the context). */
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
    hint: 'use orbitMotion.random(seed) — the same seed gives the same number: orbitMotion.random("p" + i + ":x") for the x of particle i',
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
    rule: 'webgl-msaa',
    severity: 'warning',
    pattern: /\bantialias\s*:\s*true\b/g,
    message: () => 'antialias: true is free in the tab (GPU) but multisamples in SOFTWARE in the render — measured 14m45s vs 22s',
    hint: 'create the WebGL context with antialias: false',
  },
  {
    rule: 'three-clock',
    severity: 'error',
    pattern: /\bnew\s+(?:THREE\.)?(?:Clock|Timer)\s*\(|\.setAnimationLoop\s*\(|\bgetDelta\s*\(/g,
    message: (m) => `${m.trim()} advances on wall-clock time — a three.js frame must be a pure function of the frame number`,
    hint: 'render inside window.orbitMotion.seek(frame) with t = frame / fps; mixer.setTime(t) instead of mixer.update(dt)',
  },
  {
    rule: 'three-pixel-ratio',
    severity: 'warning',
    pattern: /\bsetPixelRatio\s*\(\s*(?:window\.)?devicePixelRatio\b/g,
    message: () => 'devicePixelRatio makes the canvas 4x larger on a Retina screen — pure fill rate in a software render',
    hint: 'renderer.setPixelRatio(1) and size the canvas to the declared width/height',
  },
  {
    rule: 'three-offscreen-hide',
    severity: 'warning',
    pattern: /\.position\.(?:set\([^)]*-\s*\d{3,}|y\s*=\s*-\s*\d{3,})/g,
    message: () => 'hiding an object far away still rasterizes it (it can come back as a stray white polygon)',
    hint: 'use object.visible = false, or scale it to 0',
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

/** Attributes that point to a file, per tag. */
const ASSET_ATTRIBUTES = /<(script|link|img|video|audio|source|image|iframe|embed|object)\b([^>]*)>/gi
const ATTRIBUTE = /\b(src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi
/** What the network rule accepts without complaining: the guide's contract allows Google Fonts. */
const ALLOWED_REMOTE = /^(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com\//i

function isRemote(ref: string): boolean {
  return /^(?:https?:)?\/\//i.test(ref)
}

/** Reference to a local file (not a URL, not an anchor, not a data: URI). */
function isLocalRef(ref: string): boolean {
  const value = ref.trim()
  if (!value || value.startsWith('#') || isRemote(value)) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
}

interface Block {
  text: string
  /** Where the block starts in the file, to compute the line. */
  offset: number
}

/** The HTML's `<script>` blocks without `src` and its `<style>` blocks. */
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
    // Data JSON and template modules are not code of the composition.
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

/** Merges repeated findings of the same rule into a single line (`also at lines …`). */
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
  /** `script`, `img`, `css`… — only for the message. */
  tag: string
}

/** Every file reference in the HTML: tag attributes, `url(...)` and the CSS `@import`. */
export function collectAssetRefs(html: string): AssetRef[] {
  const refs: AssetRef[] = []
  const stripped = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n\r]/g, ' '))
  for (const tag of stripped.matchAll(ASSET_ATTRIBUTES)) {
    for (const attr of tag[2].matchAll(ATTRIBUTE)) {
      const ref = (attr[2] ?? attr[3] ?? attr[4] ?? '').trim()
      const name = attr[1].toLowerCase()
      // <link rel="canonical"> and the like point at the web, not at a file of the piece.
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

/** The `<script>` `src`s that point at a file in the folder (not a URL, not a data: URI). */
export function localScriptRefs(html: string): string[] {
  return collectAssetRefs(html)
    .filter((r) => r.tag === 'script' && isLocalRef(r.ref))
    .map((r) => r.ref)
}

/**
 * The entry HTML and its local scripts. `scripts` are the folder's AUTHORED
 * .js files — libraries (`*.min.js`) are left out by whoever builds the list.
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
  // Inline `style="…"`: only the viewport-unit rule and the transition rule.
  for (const m of html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) {
    const offset = (m.index ?? 0) + m[0].indexOf(m[1])
    findings.push(...runRules(CSS_RULES, maskCss(m[1]), offset, html))
  }
  for (const script of scripts) {
    const masked = maskJs(script.text)
    findings.push(...runRules(JS_RULES, masked, 0, script.text, script.name))
    if (signals.some((s) => s.test(masked))) animated = true
  }
  // An external script (gsap, three) or a <video> also animates.
  if (remoteScripts.some((src) => /gsap|anime|lottie|three/i.test(src))) animated = true
  if (/<video\b/i.test(html)) animated = true

  // ----------------------------------------------- audio tags on the page
  if (/<audio\b/i.test(html.replace(/<!--[\s\S]*?-->/g, ''))) {
    findings.push({
      rule: 'page-audio',
      severity: 'warning',
      message: 'an <audio> element is not captured in the render — only the tracks declared in audio.json are mixed',
      hint: 'move the file next to index.html and declare it in audio.json',
      line: lineAt(html, html.search(/<audio\b/i)),
    })
  }

  // -------------------------------------------- files and network (attributes)
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

// -------------------------------------------------------------------- audio

const at = (seconds: number): string => `${Number(seconds.toFixed(2))}s`

/** The audio manifest against the piece's length, in seconds. */
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
    if (track.gainDb > 0 && track.gainDb <= 1) {
      out.push({
        rule: 'audio-gain-linear',
        severity: 'warning',
        message: `${label} has "gain": ${track.gainDb} — gain is in dB, so this plays at FULL volume (slightly boosted), not at ${Math.round(track.gainDb * 100)}%`,
        hint: `for a quiet bed use "volume": ${track.gainDb} (linear) or "gain": -18 (dB)`,
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
  // The same file entering again without an offset starts over from 0:00 every time —
  // a song cut into scenes that keeps replaying its intro.
  const restarts = new Map<string, number>()
  for (const track of tracks) if (!track.offset && !track.loop) restarts.set(track.file, (restarts.get(track.file) ?? 0) + 1)
  for (const [file, count] of restarts) {
    if (count < 2) continue
    const name = tracks.find((t) => t.file === file)?.name ?? file
    out.push({
      rule: 'audio-restarts',
      severity: 'warning',
      message: `audio "${name}" enters ${count} times without "offset" — each entry plays the file again from 0:00`,
      hint: 'use ONE track for a continuous song (change its level with "automation" or "duck"), or give each entry the "offset" of the file second it should start from',
    })
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

// --------------------------------------------------------------- transitions

/** What the composition registered at runtime against the piece's length. */
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
  // Two transitions on the same element at the same time fight over the same
  // properties: the one registered last wins, and the other vanishes.
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

// ----------------------------------------------------------------- report

export function lintCounts(findings: LintFinding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  }
}

const MAX_REPORTED = 12

/** The report the agent reads: errors first, each with what to do about it. */
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
