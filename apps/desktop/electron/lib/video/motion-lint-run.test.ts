import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assetStatusIn, lintMotionComposition } from './motion-lint-run'

const root = path.join(os.tmpdir(), `orbit-motion-lint-${process.pid}`)
const folder = path.join(root, 'piece')
const entry = path.join(folder, 'index.html')

const html = (body: string) =>
  `<!doctype html><html><head><meta name="orbit-motion" content="duration=4"><style>@keyframes a { to { opacity: 1 } }</style></head><body>${body}</body></html>`

beforeAll(async () => {
  await fsp.mkdir(path.join(folder, 'img'), { recursive: true })
  await fsp.writeFile(path.join(folder, 'img', 'logo.png'), 'x')
  await fsp.writeFile(path.join(folder, 'main.js'), 'const t = Date.now()\n')
  await fsp.writeFile(path.join(folder, 'gsap.min.js'), 'Math.random(); Date.now()')
  await fsp.writeFile(path.join(root, 'secret.png'), 'x')
})

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('assetStatusIn', () => {
  it('existe, falta, ou sai da pasta', async () => {
    expect(await assetStatusIn(folder, 'img/logo.png')).toBe('ok')
    expect(await assetStatusIn(folder, './img/logo.png?v=2#x')).toBe('ok')
    expect(await assetStatusIn(folder, 'img/nope.png')).toBe('missing')
    expect(await assetStatusIn(folder, '../secret.png')).toBe('outside')
    expect(await assetStatusIn(folder, 'img/%E0%A4%A')).toBe('missing')
  })

  it('o caminho com barra inicial é relativo à pasta, como no scheme', async () => {
    expect(await assetStatusIn(folder, '/img/logo.png')).toBe('ok')
  })
})

describe('lintMotionComposition', () => {
  it('junta HTML, script local e arquivos — e ignora a biblioteca .min.js', async () => {
    await fsp.writeFile(
      entry,
      html(
        '<img src="img/logo.png"><img src="img/gone.png"><img src="../secret.png">' +
          '<script src="main.js"></script><script src="gsap.min.js"></script>',
      ),
    )
    const findings = await lintMotionComposition({ entry, folder })
    const byRule = (rule: string) => findings.filter((f) => f.rule === rule)
    expect(byRule('missing-asset').map((f) => f.message.split(' ')[0])).toEqual(['img/gone.png'])
    expect(byRule('asset-outside-folder')).toHaveLength(1)
    // Só o main.js (autoral) entra; o gsap.min.js tem Math.random() e fica de fora.
    expect(byRule('wall-clock')).toMatchObject([{ file: 'main.js', line: 1 }])
    expect(byRule('random')).toHaveLength(0)
  })

  it('com o que o runtime anunciou, confere as transições e o áudio contra o comprimento', async () => {
    await fsp.writeFile(entry, html('<h1>x</h1>'))
    const findings = await lintMotionComposition({
      entry,
      folder,
      runtime: {
        fps: 30,
        durationInFrames: 90,
        transitions: [{ type: 'fade', direction: null, at: 5, duration: 0.5, out: '.a', in: null }],
      },
      audio: {
        master: null,
        tracks: [
          {
            file: '/x/a.wav',
            name: 'voz',
            path: 'a.wav',
            start: 4,
            gainDb: 0,
            fadeIn: 0,
            fadeOut: 0,
            duck: false,
            fx: { eq: [], automation: [] },
          },
        ],
      },
    })
    expect(findings.map((f) => f.rule).sort()).toEqual(['audio-after-end', 'transition-after-end'])
  })

  it('arquivo ilegível ou ausente não derruba nada: relatório vazio', async () => {
    expect(await lintMotionComposition({ entry: path.join(folder, 'nao-existe.html'), folder })).toEqual([])
  })
})
