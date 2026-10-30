import { describe, expect, it } from 'vitest'
import { extractLocalUrls } from './process-manager'

describe('extractLocalUrls', () => {
  it('picks up the URL announced by a dev server (Vite)', () => {
    const output = [
      '  VITE v5.4.2  ready in 312 ms',
      '',
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: use --host to expose',
    ].join('\n')
    expect(extractLocalUrls(output)).toEqual(['http://localhost:5173'])
  })

  it('ignores the ANSI codes the server uses to paint the URL', () => {
    const esc = String.fromCharCode(27)
    expect(extractLocalUrls(`  Local:   ${esc}[36mhttp://localhost:5173/${esc}[0m`)).toEqual([
      'http://localhost:5173',
    ])
  })

  it('normalizes the listen bind (0.0.0.0 / [::1]) to localhost', () => {
    expect(extractLocalUrls('started server on 0.0.0.0:3000')).toEqual(['http://localhost:3000'])
    expect(extractLocalUrls('listening on [::1]:8080')).toEqual(['http://localhost:8080'])
    expect(extractLocalUrls('ready at http://127.0.0.1:4173')).toEqual(['http://localhost:4173'])
  })

  it('preserves https when the server announces a secure scheme', () => {
    expect(extractLocalUrls('https://localhost:3443')).toEqual(['https://localhost:3443'])
  })

  it('deduplicates — the log repeats the URL on every reload', () => {
    const output = 'http://localhost:3000\nhttp://localhost:3000\thttp://localhost:3000'
    expect(extractLocalUrls(output)).toEqual(['http://localhost:3000'])
  })

  it('only considers a server the host WITH a port', () => {
    expect(extractLocalUrls('connecting on localhost...')).toEqual([])
    expect(extractLocalUrls('Build finished in 3.2s')).toEqual([])
  })

  it('finds the server even when the log cites the URL with a path', () => {
    expect(extractLocalUrls('downloading localhost:5173/chunk.js')).toEqual(['http://localhost:5173'])
  })

  it('finds all the servers when the command starts more than one', () => {
    const output = 'api em http://localhost:4000 e web em http://localhost:5173'
    expect(extractLocalUrls(output)).toEqual(['http://localhost:4000', 'http://localhost:5173'])
  })
})
