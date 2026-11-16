import fsp from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createAssetToken } from './companion-token'
import { serveAsset } from './companion-assets'

/**
 * The import map a motion piece gets points at `/__orbit-three/…`. The desktop's scheme handler
 * serves those files; the companion has to as well, or every `import 'three'` is a 404 on the phone.
 */

const DIR = vi.hoisted(() => `/tmp/orbit-companion-three-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => DIR, getAppPath: () => `${DIR}/app`, isPackaged: false },
  BrowserWindow: class {},
}))
vi.mock('./video/motion-store', () => ({
  getMotion: async (id: string) => (id === 'mv_a' ? { folder: DIR, entry: `${DIR}/index.html` } : null),
  resolveMotionFile: (folder: string, relative: string) => `${folder}/${relative}`,
}))

let server: Server
let base = ''

beforeAll(async () => {
  await fsp.rm(DIR, { recursive: true, force: true })
  await fsp.mkdir(`${DIR}/app/node_modules/three/build`, { recursive: true })
  await fsp.mkdir(`${DIR}/app/node_modules/three/examples/jsm/loaders`, { recursive: true })
  await fsp.writeFile(`${DIR}/app/node_modules/three/build/three.module.js`, "import './three.core.js'\nexport const A = 1")
  await fsp.writeFile(`${DIR}/app/node_modules/three/build/three.core.js`, 'export const B = 2')
  await fsp.writeFile(`${DIR}/app/node_modules/three/examples/jsm/loaders/GLTFLoader.js`, 'export class GLTFLoader {}')
  await fsp.writeFile(`${DIR}/index.html`, '<!doctype html><html><head></head><body><script type="module">import * as T from "three"</script></body></html>')
  server = createServer((req, res) => {
    const m = /^\/f\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(new URL(req.url ?? '/', 'http://x').pathname)
    if (!m) return void res.writeHead(400).end()
    void serveAsset(req, res, m[1], m[2], m[3], m[4] ?? '')
  })
  base = await new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)),
  )
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fsp.rm(DIR, { recursive: true, force: true })
})

describe('three.js for a motion piece on the phone', () => {
  const token = () => createAssetToken('motion', 'mv_a')

  it('rewrites the import map to the signed HTTP path', async () => {
    const t = token()
    const html = await (await fetch(`${base}/f/motion/mv_a/${t}/index.html`)).text()
    expect(html).toContain(`/api/file/motion/mv_a/${t}/__orbit-three/three.module.js`)
    expect(html).not.toContain('orbit-motion://')
  })

  it('serves three, its split core and the addons as JavaScript (CORS open for module scripts)', async () => {
    const t = token()
    const main = await fetch(`${base}/f/motion/mv_a/${t}/__orbit-three/three.module.js`)
    expect(main.status).toBe(200)
    expect(main.headers.get('content-type')).toContain('text/javascript')
    expect(main.headers.get('access-control-allow-origin')).toBe('*')
    expect((await fetch(`${base}/f/motion/mv_a/${t}/__orbit-three/three.core.js`)).status).toBe(200)
    expect((await fetch(`${base}/f/motion/mv_a/${t}/__orbit-three/addons/loaders/GLTFLoader.js`)).status).toBe(200)
  })

  it('serves the orbit-three helper', async () => {
    const res = await fetch(`${base}/f/motion/mv_a/${token()}/__orbit-three/orbit-three.js`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('mountThree')
  })

  it('refuses anything that escapes the package or is not JavaScript', async () => {
    const t = token()
    expect((await fetch(`${base}/f/motion/mv_a/${t}/__orbit-three/..%2F..%2Fpackage.json`)).status).toBe(404)
    expect((await fetch(`${base}/f/motion/mv_a/${t}/__orbit-three/addons/..%2F..%2F..%2F..%2Findex.js`)).status).toBe(404)
  })
})
