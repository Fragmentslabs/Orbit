import { describe, expect, it } from "vitest"
import type { MediaEntry } from "@shared/media"
import { expandToGroups, groupMediaByRoot } from "./media-groups"

/**
 * A galeria é o acervo da pessoa, não o rascunho do agente. O que se testa
 * aqui é o que ela vê: quantos itens a grade mostra e o que está empilhado
 * atrás de cada um.
 */

let relogio = 0
function img(id: string, parentId?: string, source: MediaEntry["source"] = "chat"): MediaEntry {
  return {
    id,
    path: `/media/${id}`,
    size: 100,
    createdAt: ++relogio,
    source,
    kind: "image",
    parentId,
  }
}

/** A galeria entrega mais recente primeiro. */
const grade = (entries: MediaEntry[]) => [...entries].sort((a, b) => b.createdAt - a.createdAt)

describe("groupMediaByRoot", () => {
  it("uma foto editada em turnos seguidos é um item só", () => {
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const v3 = img("v3", "v2")
    const todas = [anexo, v2, v3]

    const { covers, versions } = groupMediaByRoot(todas, grade(todas))
    expect(covers.map((c) => c.id)).toEqual(["v3"])
    expect(versions.get("v3")?.map((v) => v.id)).toEqual(["anexo", "v2", "v3"])
  })

  it("duas opções para escolher são v3 e v4 do mesmo item, não dois itens", () => {
    // "tem essa e essa, qual prefere": as duas saem da mesma base e nenhuma
    // sucede a outra. Agrupar pela ponta faria dois tiles de uma edição só.
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const opcaoA = img("opcaoA", "v2")
    const opcaoB = img("opcaoB", "v2")
    const todas = [anexo, v2, opcaoA, opcaoB]

    const { covers, versions } = groupMediaByRoot(todas, grade(todas))
    expect(covers.map((c) => c.id)).toEqual(["opcaoB"])
    expect(versions.get("opcaoB")?.map((v) => v.id)).toEqual(["anexo", "v2", "opcaoA", "opcaoB"])
  })

  it("editar o original de novo continua sendo a mesma foto", () => {
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const v3 = img("v3", "anexo")
    const todas = [anexo, v2, v3]

    const { covers } = groupMediaByRoot(todas, grade(todas))
    expect(covers.map((c) => c.id)).toEqual(["v3"])
  })

  it("fotos sem parentesco continuam itens separados", () => {
    const a = img("a", undefined, "user")
    const b = img("b", undefined, "user")
    const todas = [a, b]

    const { covers, versions } = groupMediaByRoot(todas, grade(todas))
    expect(covers.map((c) => c.id).sort()).toEqual(["a", "b"])
    expect(versions.size).toBe(0)
  })

  it("um elo escondido pelo filtro não parte o grupo em dois", () => {
    // Filtro "Chat" esconde o anexo do usuário; v2 e v3 seguem juntas.
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const v3 = img("v3", "v2")
    const todas = [anexo, v2, v3]

    const { covers, versions } = groupMediaByRoot(todas, grade([v2, v3]))
    expect(covers.map((c) => c.id)).toEqual(["v3"])
    expect(versions.get("v3")?.map((v) => v.id)).toEqual(["v2", "v3"])
  })
})

describe("expandToGroups", () => {
  it("apagar o item leva as versões, menos a foto anexada pelo usuário", () => {
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const v3 = img("v3", "v2")
    const outra = img("outra", undefined, "user")

    expect(expandToGroups(["v3"], [anexo, v2, v3, outra]).sort()).toEqual(["v2", "v3"])
  })

  it("não encosta em grupo que não foi selecionado", () => {
    const a1 = img("a1", undefined, "user")
    const a2 = img("a2", "a1")
    const b1 = img("b1", undefined, "user")
    const b2 = img("b2", "b1")

    expect(expandToGroups(["a2"], [a1, a2, b1, b2])).toEqual(["a2"])
  })
})
