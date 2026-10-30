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
  it("finds by the exact id", () => {
    expect(findCatalogModel(catalog, "opencode-go", "glm-5.3")).toMatchObject({ modelId: "glm-5.3", renamed: false })
  })

  it("a renamed id becomes the family's newest successor", () => {
    expect(findCatalogModel(catalog, "opencode-go", "deepseek-flash")).toMatchObject({
      modelId: "deepseek-v4.1-flash",
      renamed: true,
    })
  })

  it("does not look for a successor in another provider", () => {
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
  it("keeps the level that exists", () => expect(closestVariant(levels, "high")).toBe("high"))
  it("goes up to the next strongest", () => expect(closestVariant(levels, "medium")).toBe("high"))
  it("above everything, it keeps the strongest", () => expect(closestVariant(["low", "medium"], "xhigh")).toBe("medium"))
  it("with no level requested, nothing", () => expect(closestVariant(levels, undefined)).toBeUndefined())
  it("a level outside the scale, nothing", () => expect(closestVariant(levels, "turbo")).toBeUndefined())
})

describe("migration of the saved choices", () => {
  it("swaps the renamed model and preserves the other fields", () => {
    expect(renamedRef(catalog, { providerId: "opencode-go", modelId: "deepseek-flash", extra: 1 })).toEqual({
      providerId: "opencode-go",
      modelId: "deepseek-v4.1-flash",
      extra: 1,
    })
  })

  it("leaves alone what still exists and what vanished with no successor", () => {
    expect(renamedRef(catalog, { providerId: "opencode-go", modelId: "glm-5.3" })).toBeUndefined()
    expect(renamedRef(catalog, { providerId: "opencode-go", modelId: "sumiu" })).toBeUndefined()
  })

  it("copies the reasoning preference to the new key", () => {
    expect(renamedPrefKeys(catalog, ["opencode-go/deepseek-flash", "opencode-go/glm-5.3", "lixo"])).toEqual([
      ["opencode-go/deepseek-flash", "opencode-go/deepseek-v4.1-flash"],
    ])
  })

  it("only reports as unavailable what does not exist even by renaming", () => {
    expect(isKnownModel(catalog, { providerId: "opencode-go", modelId: "deepseek-flash" })).toBe(true)
    expect(isKnownModel(catalog, { providerId: "opencode-go", modelId: "sumiu" })).toBe(false)
    expect(isKnownModel({}, { providerId: "opencode-go", modelId: "sumiu" })).toBe(true)
  })
})
