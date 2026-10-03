import { describe, expect, it } from "vitest"
import { closestVariant, findCatalogModel, type Catalog, type CatalogModel } from "@shared/chat"
import { isKnownModel, renamedPrefKeys, renamedRef } from "./model-migration"

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  reasoning: true,
  tool_call: true,
  attachment: false,
  ...extra,
})

const catalog: Catalog = {
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    env: [],
    models: {
      "deepseek-v4-flash": model("deepseek-v4-flash", { family: "deepseek-flash", release_date: "2026-07-31" }),
      "deepseek-v4.1-flash": model("deepseek-v4.1-flash", { family: "deepseek-flash", release_date: "2026-09-10" }),
      "glm-5.3": model("glm-5.3", { family: "glm" }),
    },
  },
}

describe("findCatalogModel", () => {
  it("acha pelo id exato", () => {
    expect(findCatalogModel(catalog, "opencode-go", "glm-5.3")).toMatchObject({ modelId: "glm-5.3", renamed: false })
  })

  it("id renomeado vira o sucessor mais novo da família", () => {
    expect(findCatalogModel(catalog, "opencode-go", "deepseek-flash")).toMatchObject({
      modelId: "deepseek-v4.1-flash",
      renamed: true,
    })
  })

  it("não procura sucessor em outro provedor", () => {
    expect(findCatalogModel(catalog, "opencode", "deepseek-flash")).toBeUndefined()
  })

  it("ignora sucessor deprecated", () => {
    const old: Catalog = {
      p: { id: "p", name: "p", env: [], models: { b: model("b", { family: "a", status: "deprecated" }) } },
    }
    expect(findCatalogModel(old, "p", "a")).toBeUndefined()
  })
})

describe("closestVariant", () => {
  const levels = ["low", "high", "max"]
  it("mantém o nível que existe", () => expect(closestVariant(levels, "high")).toBe("high"))
  it("sobe para o próximo mais forte", () => expect(closestVariant(levels, "medium")).toBe("high"))
  it("acima de tudo, fica com o mais forte", () => expect(closestVariant(["low", "medium"], "xhigh")).toBe("medium"))
  it("sem nível pedido, nada", () => expect(closestVariant(levels, undefined)).toBeUndefined())
  it("nível fora da escala, nada", () => expect(closestVariant(levels, "turbo")).toBeUndefined())
})

describe("migração das escolhas salvas", () => {
  it("troca o modelo renomeado e preserva os outros campos", () => {
    expect(renamedRef(catalog, { providerId: "opencode-go", modelId: "deepseek-flash", extra: 1 })).toEqual({
      providerId: "opencode-go",
      modelId: "deepseek-v4.1-flash",
      extra: 1,
    })
  })

  it("não mexe no que ainda existe nem no que sumiu sem sucessor", () => {
    expect(renamedRef(catalog, { providerId: "opencode-go", modelId: "glm-5.3" })).toBeUndefined()
    expect(renamedRef(catalog, { providerId: "opencode-go", modelId: "sumiu" })).toBeUndefined()
  })

  it("copia a preferência de reasoning para a chave nova", () => {
    expect(renamedPrefKeys(catalog, ["opencode-go/deepseek-flash", "opencode-go/glm-5.3", "lixo"])).toEqual([
      ["opencode-go/deepseek-flash", "opencode-go/deepseek-v4.1-flash"],
    ])
  })

  it("só acusa indisponível o que não existe nem por renomeação", () => {
    expect(isKnownModel(catalog, { providerId: "opencode-go", modelId: "deepseek-flash" })).toBe(true)
    expect(isKnownModel(catalog, { providerId: "opencode-go", modelId: "sumiu" })).toBe(false)
    expect(isKnownModel({}, { providerId: "opencode-go", modelId: "sumiu" })).toBe(true)
  })
})
