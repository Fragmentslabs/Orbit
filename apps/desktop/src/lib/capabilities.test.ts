import { describe, expect, it } from "vitest"

import en from "@/src/i18n/locales/en.json"
import ptBR from "@/src/i18n/locales/pt-BR.json"
import { CAPABILITIES } from "@/src/lib/capabilities"

/**
 * The catalog is pure data and the texts live in i18n. Without this test, adding
 * a new capability passes the typecheck, shows up on the screen — and shows the raw
 * key ("chat.start.items.audio.label") to the user.
 */

function lookup(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object") return undefined
    return (value as Record<string, unknown>)[key]
  }, source)
}

const LOCALES = [
  ["pt-BR", ptBR],
  ["en", en],
] as const

describe("capabilities catalog", () => {
  it("does not repeat an id", () => {
    const ids = CAPABILITIES.map((capability) => capability.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(LOCALES)("has every text in %s", (_locale, source) => {
    for (const capability of CAPABILITIES) {
      const fields = capability.hasExample ? ["label", "desc", "example"] : ["label", "desc", "howTo"]
      for (const field of fields) {
        const value = lookup(source, `chat.start.items.${capability.id}.${field}`)
        expect(typeof value, `${capability.id}.${field}`).toBe("string")
        expect(String(value).trim(), `${capability.id}.${field}`).not.toHaveLength(0)
      }
    }
  })

  it.each(LOCALES)("has the link, the button and the groups in %s", (_locale, source) => {
    for (const key of ["resume", "link", "title", "subtitle", "tryIt", "howTo", "disabledHint"]) {
      expect(typeof lookup(source, `chat.start.${key}`), key).toBe("string")
    }
    for (const group of ["create", "media", "work"]) {
      expect(typeof lookup(source, `chat.start.groups.${group}`), group).toBe("string")
    }
  })

  it.each(LOCALES)("has a label to enable each feature in %s", (_locale, source) => {
    // The key is built at runtime (`chat.start.enable.${requisito}`).
    // When missing, the panel shows the raw key — and only when someone turns the
    // resource off, which is exactly when nobody is looking at the translation.
    const requirements = new Set(
      CAPABILITIES.map((capability) => capability.requires).filter(Boolean),
    )
    for (const requirement of requirements) {
      expect(typeof lookup(source, `chat.start.enable.${requirement}`), String(requirement)).toBe(
        "string",
      )
    }
  })
})
