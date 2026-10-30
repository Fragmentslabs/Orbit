import { describe, expect, it } from 'vitest'
import { defaultRehypePlugins } from 'streamdown'

import { localImageRehypePlugins } from './local-image-plugins'

/**
 * This module patches the streamdown pipeline from the inside, so it depends
 * on the format the library publishes. If an update changes that format,
 * the local figure vanishes again — and in silence, which is the worst way.
 *
 * These tests exist so that the change shows up here, and not on the
 * user's screen months later.
 */

type Schema = { protocols?: Record<string, string[]> }

/** The sanitize scheme, whether from the defaults or from our pipeline. */
function schemaOf(plugin: unknown): Schema {
  expect(Array.isArray(plugin)).toBe(true)
  return (plugin as [unknown, Schema])[1]
}

const SANITIZE_INDEX = Object.keys(defaultRehypePlugins).indexOf('sanitize')

describe('local preview pipeline', () => {
  it("sanitize input is still [plugin, scheme]", () => {
    const sanitize = defaultRehypePlugins.sanitize as [unknown, Schema]

    expect(typeof sanitize[0]).toBe('function')
    expect(schemaOf(sanitize).protocols?.src).toBeDefined()
  })

  it("streamdown default does NOT accept data: in src — that is what was breaking", () => {
    expect(schemaOf(defaultRehypePlugins.sanitize).protocols?.src).not.toContain('data')
  })

  it('ours accepts it, without losing the protocols that already existed', () => {
    const original = schemaOf(defaultRehypePlugins.sanitize)
    const patched = schemaOf(localImageRehypePlugins[SANITIZE_INDEX])

    expect(patched.protocols?.src).toContain('data')
    for (const protocol of original.protocols?.src ?? []) {
      expect(patched.protocols?.src).toContain(protocol)
    }
  })

  it('keeps every streamdown step, in order, before ours', () => {
    const names = Object.keys(defaultRehypePlugins)

    // Theirs first; the caption comes in afterwards, with the text already in its final form.
    expect(localImageRehypePlugins.length).toBe(names.length + 1)
    // raw and harden pass through as they came — only sanitize is patched.
    names.forEach((name, i) => {
      if (name === 'sanitize') return
      expect(localImageRehypePlugins[i]).toBe(defaultRehypePlugins[name])
    })
  })
})
