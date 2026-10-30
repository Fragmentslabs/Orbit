import { describe, expect, it } from "vitest"

import { isLocalEndpoint } from "@/src/lib/provider-endpoint"

/**
 * The UI groups the custom providers by this helper. An error here breaks
 * nothing — it only puts a server in the wrong section, which is exactly the
 * confusion the grouping exists to solve.
 */

describe("isLocalEndpoint", () => {
  it("recognizes loopback in every form", () => {
    expect(isLocalEndpoint("http://localhost:11434/v1")).toBe(true)
    expect(isLocalEndpoint("http://LOCALHOST:11434/v1")).toBe(true)
    expect(isLocalEndpoint("http://localhost:11434/v1/")).toBe(true)
    expect(isLocalEndpoint("http://127.0.0.1:8000/v1")).toBe(true)
    expect(isLocalEndpoint("http://127.1.2.3:5000/v1")).toBe(true)
    expect(isLocalEndpoint("http://[::1]:1234/v1")).toBe(true)
    expect(isLocalEndpoint("http://api.localhost:8080/v1")).toBe(true)
    expect(isLocalEndpoint("http://localhost./v1")).toBe(true)
  })

  it("treats other machines as remote, LAN included", () => {
    expect(isLocalEndpoint("https://api.example.com/v1")).toBe(false)
    expect(isLocalEndpoint("http://192.168.1.10:11434/v1")).toBe(false)
    expect(isLocalEndpoint("http://mac-mini.local:1234/v1")).toBe(false)
    expect(isLocalEndpoint("https://openrouter.ai/api/v1")).toBe(false)
  })

  it("with no valid URL, it falls into the remote group", () => {
    expect(isLocalEndpoint(undefined)).toBe(false)
    expect(isLocalEndpoint("")).toBe(false)
    expect(isLocalEndpoint("nao-e-uma-url")).toBe(false)
  })
})
