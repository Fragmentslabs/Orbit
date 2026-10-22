import { describe, expect, it } from "vitest"

import en from "@/src/i18n/locales/en.json"
import ptBR from "@/src/i18n/locales/pt-BR.json"
import { CAPABILITIES } from "@/src/lib/capabilities"

/**
 * O catálogo é dado puro e os textos vivem no i18n. Sem este teste, adicionar
 * uma capacidade nova passa no typecheck, aparece na tela — e mostra a chave
 * crua ("chat.start.items.audio.label") para o usuário.
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

describe("catálogo de capacidades", () => {
  it("não repete id", () => {
    const ids = CAPABILITIES.map((capability) => capability.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(LOCALES)("tem todos os textos em %s", (_locale, source) => {
    for (const capability of CAPABILITIES) {
      const fields = capability.hasExample ? ["label", "desc", "example"] : ["label", "desc", "howTo"]
      for (const field of fields) {
        const value = lookup(source, `chat.start.items.${capability.id}.${field}`)
        expect(typeof value, `${capability.id}.${field}`).toBe("string")
        expect(String(value).trim(), `${capability.id}.${field}`).not.toHaveLength(0)
      }
    }
  })

  it.each(LOCALES)("tem o link, o botão e os grupos em %s", (_locale, source) => {
    for (const key of ["resume", "link", "title", "subtitle", "tryIt", "howTo", "disabledHint"]) {
      expect(typeof lookup(source, `chat.start.${key}`), key).toBe("string")
    }
    for (const group of ["create", "media", "work"]) {
      expect(typeof lookup(source, `chat.start.groups.${group}`), group).toBe("string")
    }
  })

  it.each(LOCALES)("tem rótulo para ativar cada recurso em %s", (_locale, source) => {
    // A chave é montada em tempo de execução (`chat.start.enable.${requisito}`).
    // Faltando, o painel mostra a chave crua — e só quando alguém desliga o
    // recurso, que é justamente quando ninguém está olhando a tradução.
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
