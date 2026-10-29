import fsp from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createAssetToken } from './companion-token'
import { serveAsset } from './companion-assets'

/**
 * A rota que o celular usa para TUDO que não é JSON: áudio, vídeo, artefato,
 * documento e as peças de motion/design/slides.
 *
 * Dois contratos aqui valem teste porque quebram calados: o token vale só para
 * o par escopo+id (senão um token de áudio abriria um artefato), e o Range
 * responde 206 com os bytes certos (sem ele o player não toca nem busca
 * posição).
 */

const USER_DATA = vi.hoisted(() => `/tmp/orbit-companion-assets-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, isPackaged: false },
  BrowserWindow: class {},
}))

const ORBIT_DATA = `${USER_DATA}/orbit-data`

let server: Server
let base = ''

/** Sobe um servidor mínimo na frente do serveAsset: exercita a rota de
 *  verdade (status, headers, corpo) em vez de um objeto falso de request. */
function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const match = /^\/f\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname)
      if (!match) {
        res.writeHead(400).end()
        return
      }
      void serveAsset(req, res, match[1], decodeURIComponent(match[2]), match[3], match[4] ?? '')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

beforeAll(async () => {
  await fsp.rm(USER_DATA, { recursive: true, force: true })
  await fsp.mkdir(`${ORBIT_DATA}/media`, { recursive: true })
  await fsp.mkdir(`${ORBIT_DATA}/artifacts`, { recursive: true })
  await fsp.mkdir(`${ORBIT_DATA}/audio`, { recursive: true })

  // 1x1 PNG de verdade — o teste é do transporte, não da imagem.
  await fsp.writeFile(
    `${ORBIT_DATA}/media/img_a.png`,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  await fsp.writeFile(`${ORBIT_DATA}/artifacts/art_a.html`, '<!doctype html><h1>oi</h1>')
  // 10 bytes com valores conhecidos, para conferir o recorte do Range.
  await fsp.writeFile(`${ORBIT_DATA}/audio/aud_z1.wav`, Buffer.from('0123456789'))

  base = await startServer()
})

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await fsp.rm(USER_DATA, { recursive: true, force: true })
})

/** GET na rota, com o token do par escopo+id quando o teste não passa outro. */
function get(scope: string, id: string, opts: { token?: string; relative?: string; method?: string; range?: string } = {}) {
  const token = opts.token ?? createAssetToken(scope as never, id)
  const relative = opts.relative ? `/${opts.relative}` : ''
  return fetch(`${base}/f/${scope}/${encodeURIComponent(id)}/${token}${relative}`, {
    method: opts.method ?? 'GET',
    headers: opts.range ? { Range: opts.range } : undefined,
  })
}

describe('token', () => {
  it('serve o arquivo do escopo com o token certo', async () => {
    const res = await get('artifact', 'art_a.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<h1>oi</h1>')
  })

  it('recusa o token de um escopo usado em outro', async () => {
    // O token de áudio não abre o artefato — é o que impede uma URL emitida
    // para um arquivo de servir de chave para a pasta toda.
    const res = await fetch(
      `${base}/f/artifact/art_a.html/${createAssetToken('audio', 'aud_z1.wav')}`,
    )
    expect(res.status).toBe(401)
  })

  it('recusa token expirado ou malformado', async () => {
    // `exp` no passado: a assinatura nem é conferida.
    expect((await fetch(`${base}/f/artifact/art_a.html/1.deadbeef`)).status).toBe(401)
    expect((await fetch(`${base}/f/artifact/art_a.html/abacaxi`)).status).toBe(401)
  })

  it('URL sem o segmento do token nem chega no serveAsset', async () => {
    // A rota do servidor exige escopo/id/token: sem o token o pedido cai no
    // bloqueio global de auth (401 do Bearer), nunca num arquivo sem defesa.
    const res = await fetch(`${base}/f/artifact/art_a.html/`)
    expect(res.status).toBe(400)
  })

  it('escopo desconhecido não serve nada', async () => {
    const res = await fetch(`${base}/f/segredo/art_a.html/${createAssetToken('artifact', 'art_a.html')}`)
    expect(res.status).toBe(401)
  })
})

describe('arquivos', () => {
  it('serve a imagem já existente (mesma rota das parts)', async () => {
    const res = await get('media', 'img_a.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('404 quando o id não existe ou não tem o formato que nós geramos', async () => {
    expect((await get('artifact', 'art_nao_existe.html')).status).toBe(404)
    // Fora do SAFE_ARTIFACT_ID: não vira leitura de disco.
    expect((await get('artifact', '../media-secret')).status).toBe(404)
  })

  it('404 para peça que não está registrada', async () => {
    expect((await get('motion', 'mv_naoexiste')).status).toBe(404)
    expect((await get('design', 'dsg_naoexiste')).status).toBe(404)
    expect((await get('slides', 'sld_naoexiste')).status).toBe(404)
  })
})

describe('Range', () => {
  it('responde 206 com o pedaço pedido — é o que faz o player tocar', async () => {
    const res = await get('audio', 'aud_z1.wav', { range: 'bytes=2-5' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('2345')
  })

  it('sem Range, entrega o arquivo inteiro', async () => {
    const res = await get('audio', 'aud_z1.wav')
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(await res.text()).toBe('0123456789')
  })

  it('416 quando o Range começa depois do fim', async () => {
    const res = await get('audio', 'aud_z1.wav', { range: 'bytes=99-120' })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })

  it('HEAD responde os headers sem corpo', async () => {
    const res = await get('audio', 'aud_z1.wav', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('')
  })
})
