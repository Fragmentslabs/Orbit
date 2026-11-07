import { describe, expect, it } from "vitest"
import { parseCreations } from "./fragment-creations"

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

describe("parseCreations", () => {
  it("restores valid entries", () => {
    const raw = JSON.stringify([{ sessionId: "ses-1", kind: "panel", startedAt: NOW - 1000 }])
    expect(parseCreations(raw, NOW)).toEqual([{ sessionId: "ses-1", kind: "panel", startedAt: NOW - 1000 }])
  })

  it("drops stale, malformed and unknown-kind entries", () => {
    const raw = JSON.stringify([
      { sessionId: "old", kind: "screen", startedAt: NOW - 8 * DAY },
      { sessionId: "", kind: "screen", startedAt: NOW },
      { sessionId: "bad-kind", kind: "poster", startedAt: NOW },
      { sessionId: "no-time", kind: "screen" },
      null,
      { sessionId: "ok", kind: "widget", startedAt: NOW },
    ])
    expect(parseCreations(raw, NOW).map((c) => c.sessionId)).toEqual(["ok"])
  })

  it("returns nothing for missing or corrupt storage", () => {
    expect(parseCreations(null, NOW)).toEqual([])
    expect(parseCreations("{not json", NOW)).toEqual([])
    expect(parseCreations('{"a":1}', NOW)).toEqual([])
  })
})
