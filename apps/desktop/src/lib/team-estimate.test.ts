import { describe, expect, it } from "vitest"
import { estimateTeamTokens, type PastRun } from "./team-estimate"

const run = (tokens: number, startedAt: number, status: PastRun["status"] = "ok"): PastRun => ({ status, tokens, startedAt })

describe("estimateTeamTokens", () => {
  it("has nothing to say without members", () => {
    expect(estimateTeamTokens(0)).toBeNull()
  })

  it("guesses from the member count when there is no history", () => {
    // 3 members: 3×20k+10k = 70k … 3×60k+20k = 200k
    expect(estimateTeamTokens(3)).toEqual({ low: 70_000, high: 200_000, basis: "heuristic", runs: 0 })
  })

  it("adds a third when the model reviews the work", () => {
    // 70k×4/3 = 93.3k → 90k, 200k×4/3 = 266.7k → 270k
    expect(estimateTeamTokens(3, { review: true })).toMatchObject({ low: 90_000, high: 270_000 })
  })

  it("uses the range of past runs instead of the guess", () => {
    const est = estimateTeamTokens(3, { pastRuns: [run(180_000, 1), run(320_000, 2), run(250_000, 3)] })
    expect(est).toEqual({ low: 180_000, high: 320_000, basis: "history", runs: 3 })
  })

  it("rounds outward, never inward", () => {
    const est = estimateTeamTokens(1, { pastRuns: [run(181_000, 1), run(319_001, 2)] })!
    expect(est.low).toBe(180_000)
    expect(est.high).toBe(320_000)
  })

  it("widens a single run, since one point is not a range", () => {
    expect(estimateTeamTokens(2, { pastRuns: [run(100_000, 1)] })).toMatchObject({ low: 70_000, high: 130_000, basis: "history" })
  })

  it("ignores failed, running and empty runs, and only looks at the latest five", () => {
    const est = estimateTeamTokens(2, {
      pastRuns: [run(900_000, 9, "error"), run(900_000, 8, "running"), run(0, 7), run(100_000, 1), run(110_000, 2), run(120_000, 3), run(130_000, 4), run(140_000, 5), run(150_000, 6)],
    })!
    // latest five ok runs: 150k, 140k, 130k, 120k, 110k
    expect(est).toMatchObject({ low: 110_000, high: 150_000, runs: 5 })
  })

  it("falls back to the guess when every past run failed", () => {
    expect(estimateTeamTokens(2, { pastRuns: [run(500_000, 1, "error")] })?.basis).toBe("heuristic")
  })
})
