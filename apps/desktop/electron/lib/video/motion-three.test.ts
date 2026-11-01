import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { findThreeRoot, resolveThreeFile } from './motion-three'

const ROOT = path.resolve('/app/node_modules/three')

describe('resolveThreeFile', () => {
  it('maps the module, the core and the addons', () => {
    expect(resolveThreeFile(ROOT, '/__orbit-three/three.module.js')).toBe(path.join(ROOT, 'build', 'three.module.js'))
    expect(resolveThreeFile(ROOT, '/__orbit-three/three.core.js')).toBe(path.join(ROOT, 'build', 'three.core.js'))
    expect(resolveThreeFile(ROOT, '/__orbit-three/addons/loaders/GLTFLoader.js')).toBe(
      path.join(ROOT, 'examples', 'jsm', 'loaders', 'GLTFLoader.js'),
    )
  })

  it('refuses escapes, non-js files and other paths', () => {
    expect(resolveThreeFile(ROOT, '/__orbit-three/addons/../../package.json')).toBeNull()
    expect(resolveThreeFile(ROOT, '/__orbit-three/addons/../../../x.js')).toBeNull()
    expect(resolveThreeFile(ROOT, '/__orbit-three/../package.json')).toBeNull()
    expect(resolveThreeFile(ROOT, '/__orbit-three/addons/%2e%2e/%2e%2e/x.js')).toBeNull()
    expect(resolveThreeFile(ROOT, '/__orbit-three/three.module.json')).toBeNull()
    expect(resolveThreeFile(ROOT, '/__orbit-three/addons/')).toBeNull()
    expect(resolveThreeFile(ROOT, '/index.html')).toBeNull()
  })
})

describe('findThreeRoot', () => {
  it('finds the workspace three.js from the desktop app folder', () => {
    expect(findThreeRoot(path.resolve(__dirname, '../../..'))).not.toBeNull()
  })
})
