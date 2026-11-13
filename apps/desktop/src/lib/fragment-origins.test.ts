import { describe, expect, it } from "vitest"
import type { FragmentManifest } from "@shared/fragments"
import type { FragmentProvenance } from "@shared/fragment-provenance"
import { fragmentSource } from "./fragment-origins"

const fragment = { id: "frag-local", createdAt: 0 } as FragmentManifest

const local: FragmentProvenance = { origin: "local", recordedAt: 1 }
const fromMcp: FragmentProvenance = { origin: "third_party", arrival: "mcp", recordedAt: 1 }

describe("fragmentSource", () => {
  it("reads a fragment without a provenance record as local", () => {
    expect(fragmentSource(fragment, undefined)).toBe("local")
  })

  it("keeps a local record local", () => {
    expect(fragmentSource(fragment, local)).toBe("local")
  })

  it("separates what an MCP brought from what a link, a repo or a file brought", () => {
    expect(fragmentSource(fragment, fromMcp)).toBe("integration")
    for (const arrival of ["link", "repository", "file"] as const) {
      expect(fragmentSource(fragment, { origin: "third_party", arrival, recordedAt: 1 })).toBe("imported")
    }
  })
})
