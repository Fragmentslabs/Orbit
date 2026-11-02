import { describe, expect, it } from 'vitest'
import type { MotionAudioPlan, MotionAudioTrack } from './motion-audio'
import {
  describeLint,
  lintCounts,
  lintMotionAudio,
  lintMotionSources,
  lintMotionTransitions,
  maskJs,
  type AssetStatus,
} from './motion-lint'
import type { MotionTransitionInfo } from './motion-transitions'

const page = (body: string, head = '') =>
  `<!doctype html><html><head><meta name="orbit-motion" content="duration=4">${head}</head><body>${body}</body></html>`

const lint = (html: string, status?: (ref: string) => AssetStatus) =>
  lintMotionSources({ name: 'index.html', text: html }, [], status ? { assetStatus: status } : {})
const rules = (html: string) => lint(html).map((f) => f.rule)

/** A composition that animates, so the rules do not trip on `static-piece`. */
const ANIMATED = '<style>@keyframes a { to { opacity: 1 } }</style>'

describe('three.js / WebGL rules', () => {
  const script = (js: string) => rules(page(`<script>${js}</script>${ANIMATED}`))

  it('flags MSAA, wall-clock three loops and devicePixelRatio', () => {
    expect(script('new THREE.WebGLRenderer({ antialias: true })')).toContain('webgl-msaa')
    expect(script('new THREE.WebGLRenderer({ antialias: false })')).not.toContain('webgl-msaa')
    expect(script('const c = new THREE.Clock()')).toContain('three-clock')
    expect(script('renderer.setAnimationLoop(tick)')).toContain('three-clock')
    expect(script('mixer.update(clock.getDelta())')).toContain('three-clock')
    expect(script('renderer.setPixelRatio(window.devicePixelRatio)')).toContain('three-pixel-ratio')
    expect(script('renderer.setPixelRatio(1)')).not.toContain('three-pixel-ratio')
  })

  it('flags an object parked far away instead of hidden', () => {
    expect(script('mesh.position.y = -9999')).toContain('three-offscreen-hide')
    expect(script('mesh.position.set(0, -5000, 0)')).toContain('three-offscreen-hide')
    expect(script('mesh.position.y = -2')).not.toContain('three-offscreen-hide')
  })
})

describe('maskJs', () => {
  it('hides comments and the string contents, without touching sizes or lines', () => {
    const source = `const a = "Math.random()" // Date.now()\n/* setInterval( */ const b = 'x'`
    const masked = maskJs(source)
    expect(masked).toHaveLength(source.length)
    expect(masked).not.toContain('Math.random')
    expect(masked).not.toContain('Date.now')
    expect(masked).not.toContain('setInterval')
    expect(masked.split('\n')).toHaveLength(2)
    expect(masked).toContain('const a =')
  })

  it('a URL with // inside a string does not become a comment', () => {
    const masked = maskJs(`const u = "http://x.com/a"; Math.random()`)
    expect(masked).toContain('Math.random()')
  })

  it('escaped quotes do not close the string early', () => {
    expect(maskJs(`const a = "he said \\"Date.now()\\" ok"; Math.random()`)).not.toContain('Date.now')
  })
})

describe('regras de determinismo', () => {
  it('wall clock, randomness and timers are an ERROR — they break "the frame is a function of the number"', () => {
    const found = lint(page(`<script>const t = Date.now(); const r = Math.random(); setInterval(tick, 10); ${'/*'}x${'*/'}</script>`, ANIMATED))
    const errors = found.filter((f) => f.severity === 'error').map((f) => f.rule)
    expect(errors).toEqual(expect.arrayContaining(['wall-clock', 'random', 'interval']))
    expect(found.find((f) => f.rule === 'random')?.hint).toMatch(/seeded/)
  })

  it('setTimeout and requestAnimationFrame are only a warning (waiting to load is legitimate)', () => {
    const found = lint(page(`<script>setTimeout(go, 100); requestAnimationFrame(go)</script>`, ANIMATED))
    expect(found.filter((f) => f.rule === 'timer').every((f) => f.severity === 'warning')).toBe(true)
  })

  it('does not flag what is in a comment or in text', () => {
    const html = page(`<script>
      // never use Date.now() here
      /* Math.random() */
      const label = "setInterval(" + 'performance.now()'
      window.orbitMotion.seek = (frame) => {}
    </script>`)
    expect(lint(html)).toEqual([])
  })

  it('points at the LINE in the HTML', () => {
    const html = page(`\n<script>\n\nconst r = Math.random()\n</script>`, ANIMATED)
    expect(lint(html).find((f) => f.rule === 'random')?.line).toBe(4)
  })

  it('the same repeated finding becomes one, with the other lines', () => {
    const html = page(`<script>\nMath.random()\nMath.random()\nMath.random()\n</script>`, ANIMATED)
    const randoms = lint(html).filter((f) => f.rule === 'random')
    expect(randoms).toHaveLength(1)
    expect(randoms[0].message).toMatch(/also at lines \d+, \d+/)
  })

  it('also analyzes the local scripts, naming the file', () => {
    const found = lintMotionSources(
      { name: 'index.html', text: page('<script src="anim.js"></script>', ANIMATED) },
      [{ name: 'anim.js', text: 'const x = 1\nconst y = Date.now()' }],
    )
    expect(found.find((f) => f.rule === 'wall-clock')).toMatchObject({ file: 'anim.js', line: 2 })
  })

  it('repeat: -1 and an infinite CSS animation warn that the piece ends up with no length', () => {
    const js = lint(page('<script>gsap.timeline({ repeat: -1 })</script>'))
    expect(js.map((f) => f.rule)).toContain('endless-loop')
    const css = lint(page('<style>.a { animation: spin 2s linear infinite }</style>'))
    expect(css.map((f) => f.rule)).toContain('endless-loop')
  })
})

describe('regras de CSS', () => {
  it('a CSS transition warns; "transition: none" does not', () => {
    expect(rules(page(`<style>.a { transition: opacity .3s } ${ANIMATED}</style>`))).toContain('css-transition')
    expect(rules(page(`<style>.a { transition: none } @keyframes a { to { opacity: 1 } }</style>`))).not.toContain('css-transition')
    // The -webkit- prefix is the same thing written another way, but it is not what the author writes.
    expect(rules(page(`<style>.a { -webkit-transition: none } @keyframes a { to { opacity: 1 } }</style>`))).not.toContain('css-transition')
  })

  it('viewport units warn: the composition has its OWN size', () => {
    const found = lint(page(`<style>.a { width: 50vw } @keyframes a { to { opacity: 1 } }</style>`))
    expect(found.find((f) => f.rule === 'viewport-units')?.message).toMatch(/50vw/)
    // "2vh" inside another number is not a unit.
    expect(rules(page(`<style>.a { width: 1920px } @keyframes a { to { opacity: 1 } }</style>`))).not.toContain('viewport-units')
  })

  it('a CSS comment does not count', () => {
    expect(rules(page(`<style>/* transition: all 1s */ @keyframes a { to { opacity: 1 } }</style>`))).not.toContain('css-transition')
  })
})

describe('files and network', () => {
  it('a file that does not exist is an error; one that exists passes', () => {
    const html = page(`<img src="logo.png"><img src="ok.png">${ANIMATED}`)
    const found = lint(html, (ref) => (ref === 'ok.png' ? 'ok' : 'missing'))
    const missing = found.filter((f) => f.rule === 'missing-asset')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ severity: 'error' })
    expect(missing[0].message).toMatch(/logo\.png/)
  })

  it('a path that leaves the folder is its own error: the scheme serves nothing outside it', () => {
    const found = lint(page(`<img src="../shared/logo.png">${ANIMATED}`), () => 'outside')
    expect(found.find((f) => f.rule === 'asset-outside-folder')?.severity).toBe('error')
  })

  it('also checks the CSS url(...) and the script src', () => {
    const html = page(`<style>.a { background: url("bg.jpg") } @keyframes a { to { opacity: 1 } }</style><script src="main.js"></script>`)
    const found = lint(html, () => 'missing')
    expect(found.filter((f) => f.rule === 'missing-asset').map((f) => f.message.split(' ')[0]).sort()).toEqual(['bg.jpg', 'main.js'])
  })

  it('network warns, but the guide Google Fonts passes; data: and anchors do not even enter', () => {
    const html = page(
      `<img src="https://cdn.example.com/a.png"><img src="data:image/png;base64,AAAA"><a href="#top">x</a>${ANIMATED}`,
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
    )
    const found = lint(html, () => 'missing')
    expect(found.filter((f) => f.rule === 'remote-resource')).toHaveLength(1)
    expect(found.filter((f) => f.rule === 'missing-asset')).toHaveLength(0)
  })

  it('a CDN script counts as animation (the piece is not "static")', () => {
    const html = page('<h1>Hi</h1>', '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>')
    expect(rules(html)).toContain('remote-resource')
    expect(rules(html)).not.toContain('static-piece')
  })

  it('<audio> in the page warns: the render does not capture its sound', () => {
    expect(rules(page(`<audio src="a.mp3"></audio>${ANIMATED}`))).toContain('page-audio')
  })
})

describe('static piece', () => {
  it('nothing that changes over time warns; a @keyframes, a seek or a <video> does not', () => {
    expect(rules(page('<h1>Title</h1>'))).toEqual(['static-piece'])
    expect(rules(page('<h1>x</h1>', ANIMATED))).not.toContain('static-piece')
    expect(rules(page('<script>window.orbitMotion = { seek(f) {} }</script>'))).not.toContain('static-piece')
    expect(rules(page('<video src="a.mp4"></video>'))).not.toContain('static-piece')
    expect(rules(page('<script>el.animate([], 100)</script>'))).not.toContain('static-piece')
    expect(rules(page('<script>orbitMotion.transition({})</script>'))).not.toContain('static-piece')
  })
})

describe('audio', () => {
  const track = (over: Partial<MotionAudioTrack> = {}): MotionAudioTrack => ({
    file: '/x/a.wav',
    name: 'voz',
    path: 'a.wav',
    start: 0,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    duck: false,
    fx: { eq: [], automation: [] },
    ...over,
  })
  const plan = (tracks: MotionAudioTrack[], master: MotionAudioPlan['master'] = null): MotionAudioPlan => ({ tracks, master })
  const ruleList = (p: MotionAudioPlan, seconds = 10) => lintMotionAudio(p, seconds).map((f) => f.rule)

  it('a healthy track has nothing to say', () => {
    expect(ruleList(plan([track(), track({ name: 'cama', file: '/x/b.wav', duck: true, start: 1, fadeOut: 2 })]))).toEqual([])
  })

  it('a gain between 0 and 1 reads as linear but is dB — it plays at full volume', () => {
    const [finding] = lintMotionAudio(plan([track({ gainDb: 0.15 })]), 10)
    expect(finding).toMatchObject({ rule: 'audio-gain-linear', severity: 'warning' })
    expect(finding.hint).toMatch(/"volume": 0.15/)
  })

  it('the same file entering twice without offset restarts from 0:00', () => {
    expect(ruleList(plan([track({ end: 4 }), track({ start: 4 })]))).toContain('audio-restarts')
    expect(ruleList(plan([track({ end: 4 }), track({ start: 4, offset: 4 })]))).not.toContain('audio-restarts')
  })

  it('a track that enters after the end is never heard (error)', () => {
    const [finding] = lintMotionAudio(plan([track({ start: 12 })]), 10)
    expect(finding).toMatchObject({ rule: 'audio-after-end', severity: 'error' })
    expect(finding.message).toMatch(/starts at 12s but the piece ends at 10s/)
  })

  it('ramps longer than the segment they play', () => {
    expect(ruleList(plan([track({ start: 9, fadeIn: 1, fadeOut: 1 })]))).toContain('audio-fades-overlap')
    expect(ruleList(plan([track({ start: 0, end: 3, fadeIn: 1, fadeOut: 1 })]))).not.toContain('audio-fades-overlap')
  })

  it('high gain with no limiter warns; with a limiter on the master, not', () => {
    expect(ruleList(plan([track({ gainDb: 9 })]))).toContain('audio-hot')
    expect(ruleList(plan([track({ gainDb: 9 })], { limit: -1 }))).not.toContain('audio-hot')
  })

  it('curve point after the end of the piece', () => {
    const fx = { eq: [], automation: [{ at: 14, db: 0 }] }
    expect(ruleList(plan([track({ fx })]))).toContain('audio-automation-late')
  })

  it('beds only: the duck has nothing to lower for', () => {
    expect(ruleList(plan([track({ duck: true })]))).toContain('audio-duck-alone')
    expect(ruleList(plan([track({ duck: true }), track({ name: 'voz' })]))).not.toContain('audio-duck-alone')
  })
})

describe('transitions', () => {
  const t = (over: Partial<MotionTransitionInfo> = {}): MotionTransitionInfo => ({
    type: 'push',
    direction: 'left',
    at: 2,
    duration: 0.5,
    out: '.a',
    in: '.b',
    ...over,
  })
  const ruleList = (list: MotionTransitionInfo[], seconds = 6) => lintMotionTransitions(list, seconds).map((f) => f.rule)

  it('a transition inside the piece is fine', () => {
    expect(ruleList([t()])).toEqual([])
  })

  it('starting after the end is an error; passing the end is a warning', () => {
    expect(lintMotionTransitions([t({ at: 7 })], 6)[0]).toMatchObject({ rule: 'transition-after-end', severity: 'error' })
    expect(lintMotionTransitions([t({ at: 5.8 })], 6)[0]).toMatchObject({ rule: 'transition-cut-off', severity: 'warning' })
  })

  it('two transitions on the same element at the same time fight over the properties', () => {
    expect(ruleList([t(), t({ type: 'fade', out: '.b', in: '.c', at: 2.3 })])).toEqual(['transition-overlap'])
    // In sequence (one ends when the other starts) there is no dispute.
    expect(ruleList([t(), t({ out: '.b', in: '.c', at: 2.5 })])).toEqual([])
    // Different elements at the same time either.
    expect(ruleList([t(), t({ out: '.x', in: '.y' })])).toEqual([])
  })
})

describe('describeLint', () => {
  it('with no findings, it says it is clean', () => {
    expect(describeLint([])).toBe('Lint: clean.')
  })

  it('counts, puts the errors first and brings what to do', () => {
    const findings = lint(page(`<script>setTimeout(a, 1); Math.random()</script>`, ANIMATED))
    const text = describeLint(findings)
    expect(lintCounts(findings)).toEqual({ errors: 1, warnings: 1 })
    expect(text.split('\n')[0]).toBe('Lint: 1 error, 1 warning.')
    expect(text.split('\n')[1]).toMatch(/^- \[error\] random \(line \d+\)/)
    expect(text).toMatch(/→ use a seeded generator/)
  })

  it('limits the report size', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ rule: `r${i}`, severity: 'warning' as const, message: 'm' }))
    const text = describeLint(many)
    expect(text).toContain('… and 8 more.')
    expect(text.split('\n').length).toBeLessThanOrEqual(14)
  })
})
