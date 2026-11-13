import { describe, expect, it } from "vitest"
import {
  isScriptTriggered,
  nextRoutineRun,
  scriptApproved,
  scriptFingerprint,
  triggerScript,
  upcomingRuns,
  type Routine,
  type RoutineScript,
} from "@shared/routines"

const script: RoutineScript = { id: "s1", name: "watch", summary: "x", code: "return 1", hosts: ["b.com", "a.com"] }

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: "r",
    title: "t",
    prompt: "p",
    schedule: { time: "09:00" },
    model: { providerId: "p", modelId: "m" },
    modes: {},
    folders: ["/a"],
    active: true,
    createdAt: 0,
    ...over,
  }
}

describe("script approval", () => {
  it("a script is approved only while code, hosts and file access are exactly what was approved", () => {
    const approved = { ...script, approvedFingerprint: scriptFingerprint(script) }
    expect(scriptApproved(approved)).toBe(true)
    expect(scriptApproved({ ...approved, code: "return 2" })).toBe(false)
    expect(scriptApproved({ ...approved, hosts: [...approved.hosts, "evil.com"] })).toBe(false)
    expect(scriptApproved({ ...approved, readFiles: true })).toBe(false)
    expect(scriptApproved(script)).toBe(false)
  })

  it("a secret and a database with the same name never share a fingerprint", () => {
    const secret = scriptFingerprint({ ...script, secrets: ["X"] })
    const database = scriptFingerprint({ ...script, databases: ["X"] })
    expect(secret).not.toBe(database)
    expect(scriptFingerprint({ ...script, secrets: ["X"], databases: ["X"] })).not.toBe(secret)
  })

  it("scripts approved before secrets and databases existed keep their fingerprint", () => {
    expect(scriptFingerprint(script)).toBe(JSON.stringify([script.code, ["a.com", "b.com"], false]))
  })

  it("host order does not change the fingerprint", () => {
    expect(scriptFingerprint(script)).toBe(scriptFingerprint({ ...script, hosts: ["a.com", "b.com"] }))
  })
})

describe("script-triggered routines", () => {
  const watched = routine({ scripts: [script], trigger: { kind: "script", scriptId: "s1", everyMinutes: 5 } })

  it("finds its trigger script", () => {
    expect(triggerScript(watched)?.name).toBe("watch")
    expect(triggerScript(routine())).toBeUndefined()
    expect(isScriptTriggered(watched)).toBe(true)
  })

  it("has no calendar: no next run and nothing in the agenda", () => {
    expect(nextRoutineRun(watched)).toBeNull()
    expect(upcomingRuns(watched, 0, 7 * 24 * 3_600_000)).toEqual([])
    expect(nextRoutineRun(routine())).not.toBeNull()
  })
})
