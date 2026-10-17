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

/** Uma composição que anima, para as regras não esbarrarem na `static-piece`. */
const ANIMATED = '<style>@keyframes a { to { opacity: 1 } }</style>'

describe('maskJs', () => {
  it('esconde comentários e o conteúdo das strings, sem mexer em tamanhos nem linhas', () => {
    const source = `const a = "Math.random()" // Date.now()\n/* setInterval( */ const b = 'x'`
    const masked = maskJs(source)
    expect(masked).toHaveLength(source.length)
    expect(masked).not.toContain('Math.random')
    expect(masked).not.toContain('Date.now')
    expect(masked).not.toContain('setInterval')
    expect(masked.split('\n')).toHaveLength(2)
    expect(masked).toContain('const a =')
  })

  it('uma URL com // dentro de string não vira comentário', () => {
    const masked = maskJs(`const u = "http://x.com/a"; Math.random()`)
    expect(masked).toContain('Math.random()')
  })

  it('aspas escapadas não fecham a string cedo', () => {
    expect(maskJs(`const a = "he said \\"Date.now()\\" ok"; Math.random()`)).not.toContain('Date.now')
  })
})

describe('regras de determinismo', () => {
  it('relógio de parede, sorteio e intervalo são ERRO — quebram "o quadro é função do número"', () => {
    const found = lint(page(`<script>const t = Date.now(); const r = Math.random(); setInterval(tick, 10); ${'/*'}x${'*/'}</script>`, ANIMATED))
    const errors = found.filter((f) => f.severity === 'error').map((f) => f.rule)
    expect(errors).toEqual(expect.arrayContaining(['wall-clock', 'random', 'interval']))
    expect(found.find((f) => f.rule === 'random')?.hint).toMatch(/seeded/)
  })

  it('setTimeout e requestAnimationFrame são só aviso (esperar carregar é legítimo)', () => {
    const found = lint(page(`<script>setTimeout(go, 100); requestAnimationFrame(go)</script>`, ANIMATED))
    expect(found.filter((f) => f.rule === 'timer').every((f) => f.severity === 'warning')).toBe(true)
  })

  it('não acusa o que está em comentário ou em texto', () => {
    const html = page(`<script>
      // nunca use Date.now() aqui
      /* Math.random() */
      const label = "setInterval(" + 'performance.now()'
      window.orbitMotion.seek = (frame) => {}
    </script>`)
    expect(lint(html)).toEqual([])
  })

  it('aponta a LINHA no HTML', () => {
    const html = page(`\n<script>\n\nconst r = Math.random()\n</script>`, ANIMATED)
    expect(lint(html).find((f) => f.rule === 'random')?.line).toBe(4)
  })

  it('o mesmo achado repetido vira um só, com as outras linhas', () => {
    const html = page(`<script>\nMath.random()\nMath.random()\nMath.random()\n</script>`, ANIMATED)
    const randoms = lint(html).filter((f) => f.rule === 'random')
    expect(randoms).toHaveLength(1)
    expect(randoms[0].message).toMatch(/also at lines \d+, \d+/)
  })

  it('analisa também os scripts locais, nomeando o arquivo', () => {
    const found = lintMotionSources(
      { name: 'index.html', text: page('<script src="anim.js"></script>', ANIMATED) },
      [{ name: 'anim.js', text: 'const x = 1\nconst y = Date.now()' }],
    )
    expect(found.find((f) => f.rule === 'wall-clock')).toMatchObject({ file: 'anim.js', line: 2 })
  })

  it('repeat: -1 e animação CSS infinita avisam que a peça fica sem comprimento', () => {
    const js = lint(page('<script>gsap.timeline({ repeat: -1 })</script>'))
    expect(js.map((f) => f.rule)).toContain('endless-loop')
    const css = lint(page('<style>.a { animation: spin 2s linear infinite }</style>'))
    expect(css.map((f) => f.rule)).toContain('endless-loop')
  })
})

describe('regras de CSS', () => {
  it('transição CSS avisa; "transition: none" não', () => {
    expect(rules(page(`<style>.a { transition: opacity .3s } ${ANIMATED}</style>`))).toContain('css-transition')
    expect(rules(page(`<style>.a { transition: none } @keyframes a { to { opacity: 1 } }</style>`))).not.toContain('css-transition')
    // O prefixo -webkit- é a mesma coisa escrita de outro jeito, mas não é o que o autor escreve.
    expect(rules(page(`<style>.a { -webkit-transition: none } @keyframes a { to { opacity: 1 } }</style>`))).not.toContain('css-transition')
  })

  it('unidades de viewport avisam: a composição tem tamanho PRÓPRIO', () => {
    const found = lint(page(`<style>.a { width: 50vw } @keyframes a { to { opacity: 1 } }</style>`))
    expect(found.find((f) => f.rule === 'viewport-units')?.message).toMatch(/50vw/)
    // "2vh" dentro de outro número não é unidade.
    expect(rules(page(`<style>.a { width: 1920px } @keyframes a { to { opacity: 1 } }</style>`))).not.toContain('viewport-units')
  })

  it('comentário de CSS não conta', () => {
    expect(rules(page(`<style>/* transition: all 1s */ @keyframes a { to { opacity: 1 } }</style>`))).not.toContain('css-transition')
  })
})

describe('arquivos e rede', () => {
  it('arquivo que não existe é erro; um que existe passa', () => {
    const html = page(`<img src="logo.png"><img src="ok.png">${ANIMATED}`)
    const found = lint(html, (ref) => (ref === 'ok.png' ? 'ok' : 'missing'))
    const missing = found.filter((f) => f.rule === 'missing-asset')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ severity: 'error' })
    expect(missing[0].message).toMatch(/logo\.png/)
  })

  it('caminho que sai da pasta é erro próprio: o scheme não serve nada fora dela', () => {
    const found = lint(page(`<img src="../shared/logo.png">${ANIMATED}`), () => 'outside')
    expect(found.find((f) => f.rule === 'asset-outside-folder')?.severity).toBe('error')
  })

  it('confere também url(...) do CSS e o src do script', () => {
    const html = page(`<style>.a { background: url("bg.jpg") } @keyframes a { to { opacity: 1 } }</style><script src="main.js"></script>`)
    const found = lint(html, () => 'missing')
    expect(found.filter((f) => f.rule === 'missing-asset').map((f) => f.message.split(' ')[0]).sort()).toEqual(['bg.jpg', 'main.js'])
  })

  it('rede avisa, mas o Google Fonts do guia passa; data: e âncoras nem entram', () => {
    const html = page(
      `<img src="https://cdn.example.com/a.png"><img src="data:image/png;base64,AAAA"><a href="#top">x</a>${ANIMATED}`,
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
    )
    const found = lint(html, () => 'missing')
    expect(found.filter((f) => f.rule === 'remote-resource')).toHaveLength(1)
    expect(found.filter((f) => f.rule === 'missing-asset')).toHaveLength(0)
  })

  it('um script de CDN conta como animação (a peça não é "estática")', () => {
    const html = page('<h1>Hi</h1>', '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>')
    expect(rules(html)).toContain('remote-resource')
    expect(rules(html)).not.toContain('static-piece')
  })

  it('<audio> na página avisa: o render não captura o som dela', () => {
    expect(rules(page(`<audio src="a.mp3"></audio>${ANIMATED}`))).toContain('page-audio')
  })
})

describe('peça estática', () => {
  it('nada que mude no tempo avisa; um @keyframes, um seek ou um <video> não', () => {
    expect(rules(page('<h1>Title</h1>'))).toEqual(['static-piece'])
    expect(rules(page('<h1>x</h1>', ANIMATED))).not.toContain('static-piece')
    expect(rules(page('<script>window.orbitMotion = { seek(f) {} }</script>'))).not.toContain('static-piece')
    expect(rules(page('<video src="a.mp4"></video>'))).not.toContain('static-piece')
    expect(rules(page('<script>el.animate([], 100)</script>'))).not.toContain('static-piece')
    expect(rules(page('<script>orbitMotion.transition({})</script>'))).not.toContain('static-piece')
  })
})

describe('áudio', () => {
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

  it('uma faixa saudável não tem nada a dizer', () => {
    expect(ruleList(plan([track(), track({ name: 'cama', duck: true, start: 1, fadeOut: 2 })]))).toEqual([])
  })

  it('faixa que entra depois do fim nunca é ouvida (erro)', () => {
    const [finding] = lintMotionAudio(plan([track({ start: 12 })]), 10)
    expect(finding).toMatchObject({ rule: 'audio-after-end', severity: 'error' })
    expect(finding.message).toMatch(/starts at 12s but the piece ends at 10s/)
  })

  it('rampas maiores que o trecho que toca', () => {
    expect(ruleList(plan([track({ start: 9, fadeIn: 1, fadeOut: 1 })]))).toContain('audio-fades-overlap')
    expect(ruleList(plan([track({ start: 0, end: 3, fadeIn: 1, fadeOut: 1 })]))).not.toContain('audio-fades-overlap')
  })

  it('ganho alto sem limitador avisa; com limitador no master, não', () => {
    expect(ruleList(plan([track({ gainDb: 9 })]))).toContain('audio-hot')
    expect(ruleList(plan([track({ gainDb: 9 })], { limit: -1 }))).not.toContain('audio-hot')
  })

  it('ponto de curva depois do fim da peça', () => {
    const fx = { eq: [], automation: [{ at: 14, db: 0 }] }
    expect(ruleList(plan([track({ fx })]))).toContain('audio-automation-late')
  })

  it('só camas: o duck não tem por quem abaixar', () => {
    expect(ruleList(plan([track({ duck: true })]))).toContain('audio-duck-alone')
    expect(ruleList(plan([track({ duck: true }), track({ name: 'voz' })]))).not.toContain('audio-duck-alone')
  })
})

describe('transições', () => {
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

  it('uma transição dentro da peça está bem', () => {
    expect(ruleList([t()])).toEqual([])
  })

  it('começar depois do fim é erro; passar do fim é aviso', () => {
    expect(lintMotionTransitions([t({ at: 7 })], 6)[0]).toMatchObject({ rule: 'transition-after-end', severity: 'error' })
    expect(lintMotionTransitions([t({ at: 5.8 })], 6)[0]).toMatchObject({ rule: 'transition-cut-off', severity: 'warning' })
  })

  it('duas transições no mesmo elemento ao mesmo tempo disputam as propriedades', () => {
    expect(ruleList([t(), t({ type: 'fade', out: '.b', in: '.c', at: 2.3 })])).toEqual(['transition-overlap'])
    // Em sequência (uma termina quando a outra começa) não há disputa.
    expect(ruleList([t(), t({ out: '.b', in: '.c', at: 2.5 })])).toEqual([])
    // Elementos diferentes ao mesmo tempo também não.
    expect(ruleList([t(), t({ out: '.x', in: '.y' })])).toEqual([])
  })
})

describe('describeLint', () => {
  it('sem achados, diz que está limpo', () => {
    expect(describeLint([])).toBe('Lint: clean.')
  })

  it('conta, põe os erros primeiro e traz o que fazer', () => {
    const findings = lint(page(`<script>setTimeout(a, 1); Math.random()</script>`, ANIMATED))
    const text = describeLint(findings)
    expect(lintCounts(findings)).toEqual({ errors: 1, warnings: 1 })
    expect(text.split('\n')[0]).toBe('Lint: 1 error, 1 warning.')
    expect(text.split('\n')[1]).toMatch(/^- \[error\] random \(line \d+\)/)
    expect(text).toMatch(/→ use a seeded generator/)
  })

  it('limita o tamanho do relatório', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ rule: `r${i}`, severity: 'warning' as const, message: 'm' }))
    const text = describeLint(many)
    expect(text).toContain('… and 8 more.')
    expect(text.split('\n').length).toBeLessThanOrEqual(14)
  })
})
