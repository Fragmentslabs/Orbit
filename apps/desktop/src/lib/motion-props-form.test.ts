import { describe, expect, it } from "vitest"
import {
  changedCount,
  defaultValues,
  encodeOverrides,
  fieldError,
  srcWithProps,
  toOverrides,
  type MotionPropDef,
} from "./motion-props-form"

const schema: Record<string, MotionPropDef> = {
  title: { type: "text", default: "Black Friday" },
  price: { type: "number", default: 99, min: 0, max: 1000 },
  color: { type: "color", default: "#c93b64" },
  tone: { type: "select", default: "warm", options: ["warm", "cool"] },
  logo: { type: "image", default: "logo.png" },
  on: { type: "boolean", default: true },
}

describe("defaultValues", () => {
  it("holds text for everything but the switches", () => {
    expect(defaultValues(schema)).toEqual({ title: "Black Friday", price: "99", color: "#c93b64", tone: "warm", logo: "logo.png", on: true })
  })
})

describe("fieldError", () => {
  it("accepts what main accepts, including the decimal comma", () => {
    expect(fieldError(schema.price, "12,5")).toBeNull()
    expect(fieldError(schema.color, "#fff")).toBeNull()
    expect(fieldError(schema.tone, "cool")).toBeNull()
    expect(fieldError(schema.logo, "img/a.png")).toBeNull()
    expect(fieldError(schema.title, "")).toBeNull() // an empty text is a valid text
  })
  it("says which rule a value breaks", () => {
    expect(fieldError(schema.price, "")).toBe("required")
    expect(fieldError(schema.price, "abc")).toBe("number")
    expect(fieldError(schema.price, "-1")).toBe("min:0")
    expect(fieldError(schema.price, "5000")).toBe("max:1000")
    expect(fieldError(schema.color, "red")).toBe("color")
    expect(fieldError(schema.tone, "hot")).toBe("select")
    for (const bad of ["", "../x.png", "/etc/x", "https://x.test/a.png"]) expect(fieldError(schema.logo, bad), bad).toBe("path")
  })
})

describe("toOverrides", () => {
  it("only what differs from the defaults, with the right types", () => {
    const values = { ...defaultValues(schema), title: "Oferta A", price: "49,5", on: false }
    const { overrides, errors } = toOverrides(schema, values)
    expect(errors).toEqual({})
    expect(overrides).toEqual({ title: "Oferta A", price: 49.5, on: false })
    expect(changedCount(overrides)).toBe(3)
  })
  it("nothing changed means no overrides at all", () => {
    expect(toOverrides(schema, defaultValues(schema))).toEqual({ overrides: {}, errors: {} })
  })
  it("an invalid field is reported and left out, the valid ones still go", () => {
    const { overrides, errors } = toOverrides(schema, { ...defaultValues(schema), price: "abc", title: "Novo" })
    expect(errors).toEqual({ price: "number" })
    expect(overrides).toEqual({ title: "Novo" })
  })
  it("a value typed back to the default is no longer an override", () => {
    expect(toOverrides(schema, { ...defaultValues(schema), price: "99" }).overrides).toEqual({})
  })
})

describe("transport", () => {
  it("is the base64url of the UTF-8 JSON, the way main decodes it", () => {
    const o = { title: 'Ação "oi" — 49', n: 3 }
    const enc = encodeOverrides(o)
    expect(enc).not.toMatch(/[+/=]/)
    expect(JSON.parse(Buffer.from(enc, "base64url").toString("utf8"))).toEqual(o)
  })
  it("appends to a URL that already has a query, and leaves it alone with no overrides", () => {
    const base = "orbit-motion://mv_x/index.html?r=0"
    expect(srcWithProps(base, {})).toBe(base)
    expect(srcWithProps("", { a: 1 })).toBe("")
    const url = srcWithProps(base, { a: 1 })
    expect(url.startsWith(`${base}&orbitProps=`)).toBe(true)
    expect(srcWithProps("orbit-motion://mv_x/index.html", { a: 1 })).toContain("index.html?orbitProps=")
  })
})
