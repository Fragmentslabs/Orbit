import { describe, expect, it } from 'vitest'
import { extractLocalUrls } from './process-manager'

describe('extractLocalUrls', () => {
  it('pega a URL anunciada por um dev server (Vite)', () => {
    const output = [
      '  VITE v5.4.2  ready in 312 ms',
      '',
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: use --host to expose',
    ].join('\n')
    expect(extractLocalUrls(output)).toEqual(['http://localhost:5173'])
  })

  it('ignora os códigos ANSI que o servidor usa para pintar a URL', () => {
    const esc = String.fromCharCode(27)
    expect(extractLocalUrls(`  Local:   ${esc}[36mhttp://localhost:5173/${esc}[0m`)).toEqual([
      'http://localhost:5173',
    ])
  })

  it('normaliza bind de escuta (0.0.0.0 / [::1]) para localhost', () => {
    expect(extractLocalUrls('started server on 0.0.0.0:3000')).toEqual(['http://localhost:3000'])
    expect(extractLocalUrls('listening on [::1]:8080')).toEqual(['http://localhost:8080'])
    expect(extractLocalUrls('ready at http://127.0.0.1:4173')).toEqual(['http://localhost:4173'])
  })

  it('preserva https quando o servidor anuncia com esquema seguro', () => {
    expect(extractLocalUrls('https://localhost:3443')).toEqual(['https://localhost:3443'])
  })

  it('deduplica — o log repete a URL a cada reload', () => {
    const output = 'http://localhost:3000\nhttp://localhost:3000\thttp://localhost:3000'
    expect(extractLocalUrls(output)).toEqual(['http://localhost:3000'])
  })

  it('só considera servidor o host COM porta', () => {
    expect(extractLocalUrls('conectando em localhost...')).toEqual([])
    expect(extractLocalUrls('Build concluído em 3.2s')).toEqual([])
  })

  it('acha o servidor mesmo quando o log cita a URL com caminho', () => {
    expect(extractLocalUrls('baixando localhost:5173/chunk.js')).toEqual(['http://localhost:5173'])
  })

  it('acha todos os servidores quando o comando sobe mais de um', () => {
    const output = 'api em http://localhost:4000 e web em http://localhost:5173'
    expect(extractLocalUrls(output)).toEqual(['http://localhost:4000', 'http://localhost:5173'])
  })
})
