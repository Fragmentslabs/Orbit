/**
 * VALIDATION runner (not tuning).
 *
 *   MEMORY_AUDIT=1 npx vitest run electron/lib/memory/bench/audit.test.ts
 *
 * Unlike eval.test.ts, this file does NOT calibrate anything on the set
 * it evaluates: it applies the policies pre-registered in policy.ts and measures. Here
 * go the confusion matrix, the pointer forensics, the blocked set
 * and the ablations (lexical, language, dialog).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contextualQuery } from '@shared/memory-query'
import { quantile } from '@shared/memory-select'
import { evaluatePolicy, orderFor, prepare, rankingBreakdown, type ModelData } from './analysis'
import { rankOfFirstRelevant, wilson, type Outcome } from './harness'
import { INJECTION_PRECISION_CI_FLOOR, INJECTION_PRECISION_TARGET, P1, P2, P3, type Policy } from './policy'
import { loadFixture, loadModel, OUT, type ModelId } from './support'

const MODELS: ModelId[] = ['a8m', 'a25m']
const gated = process.env.MEMORY_AUDIT ? describe : describe.skip

const EXPECT = ['inject', 'pointer', 'none'] as const
type Decision = (typeof EXPECT)[number]

/**
 * Decision taken, from the case's point of view.
 * For `expect: none` ANY memory is noise: an injection counts as
 * 'inject' and a pointer as 'pointer' even with no relevant memory existing.
 */
function predicted(o: Outcome): Decision {
  const rel = new Set(o.case.relevant)
  if (o.injected.some((id) => rel.has(id))) return 'inject'
  if (o.pointers.some((id) => rel.has(id))) return 'pointer'
  if (o.case.expect === 'none') return o.injected.length ? 'inject' : o.pointers.length ? 'pointer' : 'none'
  return 'none'
}

export interface Confusion {
  matrix: Record<Decision, Record<Decision, number>>
  expected: Record<Decision, number>
  decided: Record<Decision, number>
}

export function confusion(outs: Outcome[]): Confusion {
  const empty = () => ({ inject: 0, pointer: 0, none: 0 }) as Record<Decision, number>
  const matrix = { inject: empty(), pointer: empty(), none: empty() }
  const expected = empty()
  const decided = empty()
  for (const o of outs) {
    const p = predicted(o)
    matrix[o.case.expect][p]++
    expected[o.case.expect]++
    decided[p]++
  }
  return { matrix, expected, decided }
}

export interface Precision {
  correct: number
  total: number
  precision: number
  ci: [number, number]
}

/** Precision per injected MEMORY (not per query) — the one that decides injection. */
export function injectionPrecision(outs: Outcome[]): Precision {
  let correct = 0
  let total = 0
  for (const o of outs) {
    const rel = new Set(o.case.relevant)
    total += o.injected.length
    correct += o.injected.filter((id) => rel.has(id)).length
  }
  return { correct, total, precision: total ? correct / total : NaN, ci: wilson(correct, total) }
}

/** Injections that were not relevant, with the case and the cosine — audit. */
export function falsePositiveDetail(outs: Outcome[]) {
  const rows: Array<{ case: string; lang: string; injected: string; relevant: string[]; cos: number | null; expect: string }> = []
  for (const o of outs) {
    const rel = new Set(o.case.relevant)
    for (const id of o.injected) {
      if (rel.has(id)) continue
      rows.push({
        case: o.case.id,
        lang: o.case.lang,
        injected: id,
        relevant: o.case.relevant,
        cos: o.candidates.find((c) => c.id === id)?.cos ?? null,
        expect: o.case.expect,
      })
    }
  }
  return rows
}

export interface PointerRow {
  id: string
  lang: string
  relevant: string
  goldInCandidates: boolean
  goldRank: number | null
  goldCos: number | null
  topCos: number | null
  pointerT: number
  nAbovePointerT: number
  pointers: string[]
  decided: Decision
}

/** Why each `pointer` case ended the way it did. */
export function pointerForensics(outs: Outcome[], data: ModelData, policy: Policy): PointerRow[] {
  const pointerT = policy.useNoise
    ? quantile(data.noise.full.tops, policy.selection.noiseQuantile) + policy.selection.pointerDelta
    : policy.selection.pointerCos
  return outs
    .filter((o) => o.case.expect === 'pointer')
    .map((o) => {
      const byCos = o.candidates.filter((c) => c.cos != null).sort((a, b) => (b.cos ?? 0) - (a.cos ?? 0))
      const idx = byCos.findIndex((c) => o.case.relevant.includes(c.id))
      return {
        id: o.case.id,
        lang: o.case.lang,
        relevant: o.case.relevant.join(','),
        goldInCandidates: o.candidates.some((c) => o.case.relevant.includes(c.id)),
        goldRank: idx >= 0 ? idx + 1 : null,
        goldCos: idx >= 0 ? byCos[idx].cos : null,
        topCos: byCos[0]?.cos ?? null,
        pointerT,
        nAbovePointerT: byCos.filter((c) => (c.cos ?? 0) >= pointerT).length,
        pointers: o.pointers,
        decided: predicted(o),
      }
    })
}

/**
 * Pointer-level curve, computed over the CANDIDATES (which do not depend on
 * the threshold): for each threshold and each pointer ceiling, how many
 * `pointer` cases would be served and in how many no-memory queries a
 * pointer would come out.
 */
export function pointerCurve(outs: Outcome[], thresholds: number[], maxPointers: number[]) {
  const rows: Array<{ t: number; max: number; useful: number; pointerCases: number; negWithPointer: number; negatives: number; anyPointer: number }> = []
  for (const max of maxPointers) {
    for (const t of thresholds) {
      let useful = 0
      let pointerCases = 0
      let negWithPointer = 0
      let negatives = 0
      let anyPointer = 0
      for (const o of outs) {
        const top = o.candidates
          .filter((c) => c.cos != null)
          .sort((a, b) => (b.cos ?? 0) - (a.cos ?? 0))
          .slice(0, max)
          .filter((c) => (c.cos ?? 0) >= t)
          .map((c) => c.id)
        if (top.length) anyPointer++
        if (o.case.expect === 'pointer') {
          pointerCases++
          if (top.some((id) => o.case.relevant.includes(id))) useful++
        } else if (o.case.expect === 'none') {
          negatives++
          if (top.length) negWithPointer++
        }
      }
      rows.push({ t, max, useful, pointerCases, negWithPointer, negatives, anyPointer })
    }
  }
  return rows
}

/**
 * "Strict" injection threshold: the HIGHEST one that still injects something with zero
 * irrelevant memories on dev. Chosen on dev only, as the procedure demands.
 */
function strictInjectCos(data: ModelData, fx: ReturnType<typeof loadFixture>, policy: Policy): number {
  let chosen = 2
  for (let t = 0.6; t <= 0.96; t += 0.02) {
    const { met } = evaluatePolicy(data, fx, 'full', { ...policy.selection, injectCos: t }, policy.useNoise, 'dev', policy.retrieval)
    if (met.falsePositives === 0 && met.injectedTotal > 0) chosen = t
  }
  return Number(chosen.toFixed(2))
}

/** Pre-registered ladder rule: precision >= 98% AND lower 95% CI >= 90%. */
function verdict(p: Precision): 'aprovada' | 'reprovada' {
  if (!Number.isFinite(p.precision) || !p.total) return 'reprovada'
  return p.precision >= INJECTION_PRECISION_TARGET && p.ci[0] >= INJECTION_PRECISION_CI_FLOOR ? 'aprovada' : 'reprovada'
}

function summarize(label: string, outs: Outcome[]) {
  const conf = confusion(outs)
  const prec = injectionPrecision(outs)
  return { label, n: outs.length, confusion: conf, precision: prec, verdict: verdict(prec) }
}


/** AUC: P(cosine of the right memory > highest cosine of a no-memory query). */
export function aucOnSet(outs: Outcome[]): number {
  const pos: number[] = []
  const neg: number[] = []
  for (const o of outs) {
    const cos = o.candidates.filter((c) => c.cos != null).map((c) => c.cos as number)
    if (o.case.expect === 'none') {
      if (cos.length) neg.push(Math.max(...cos))
      continue
    }
    const gold = o.candidates.filter((c) => o.case.relevant.includes(c.id)).map((c) => c.cos as number)
    if (gold.length) pos.push(Math.max(...gold))
  }
  if (!pos.length || !neg.length) return NaN
  let s = 0
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0
  return s / (pos.length * neg.length)
}

gated('contextual memory validation', () => {
  for (const id of MODELS) {
    it(
      `Bekko ${id}`,
      async () => {
        const model = await loadModel(id)
        const main = loadFixture('main')
        const blocked = loadFixture('blocked')
        const dataMain = await prepare(model.embed, main)
        const dataBlocked = await prepare(model.embed, blocked)

        // ---- 1. Current policy (P1) on the tuning fixture -----------------
        const evalOut = evaluatePolicy(dataMain, main, 'full', P1.selection, P1.useNoise, 'eval', P1.retrieval)
        const devOut = evaluatePolicy(dataMain, main, 'full', P1.selection, P1.useNoise, 'dev', P1.retrieval)
        const forensic = pointerForensics(evalOut.outs, dataMain, P1)

        // Pointer curve: calibrated on DEV (never on eval).
        const thresholds = Array.from({ length: 27 }, (_, i) => Number((0.3 + i * 0.01).toFixed(2)))
        const curveDev = pointerCurve(devOut.outs, thresholds, [1, 2])
        const negatives = curveDev.find((r) => r.max === 2)?.negatives ?? 1
        const viable = curveDev.filter((r) => r.negWithPointer / Math.max(1, negatives) <= 0.25 && r.useful > 0)
        // Rule: most `pointer` cases served; tie → higher threshold and fewer pointers.
        const pick = viable.sort((a, b) => b.useful - a.useful || b.t - a.t || a.max - b.max)[0]
        const pointerFix = pick ? { pointerCos: pick.t, maxPointers: pick.max, devUseful: pick.useful, devNeg: pick.negWithPointer } : null

        // P1b = P1 with the pointer level recalibrated separately on dev.
        const P1b: Policy = {
          ...P1,
          id: 'P1',
          name: `P1 injection + own pointer (${pointerFix?.pointerCos ?? P1.selection.pointerCos}, top-${pointerFix?.maxPointers ?? 2})`,
          selection: {
            ...P1.selection,
            pointerCos: pointerFix?.pointerCos ?? P1.selection.pointerCos,
            maxPointers: pointerFix?.maxPointers ?? P1.selection.maxPointers,
          },
        }

        // ---- 2. Decision ladder on the BLOCKED set ------------------------
        const strictCos = strictInjectCos(dataMain, main, P1)
        const P3s = { ...P3(strictCos), selection: { ...P3(strictCos).selection, pointerCos: P1b.selection.pointerCos, maxPointers: P1b.selection.maxPointers } }
        const candidates = [
          { policy: P1b, name: 'P1b calibrated injection + own pointer' },
          { policy: P3s, name: `P3 strict injection (${strictCos})` },
          { policy: P2, name: 'P2 pointers only' },
        ]
        const blockedEvals = candidates.map((c) => ({
          c,
          outs: evaluatePolicy(dataBlocked, blocked, 'full', c.policy.selection, c.policy.useNoise, 'blocked', c.policy.retrieval).outs,
        }))
        const P1bOuts = blockedEvals[0].outs
        const blockedRuns = blockedEvals.map(({ c, outs }) => ({
          name: c.name,
          policy: { id: c.policy.id, injectCos: c.policy.selection.injectCos, pointerCos: c.policy.selection.pointerCos, maxPointers: c.policy.selection.maxPointers },
          ...summarize(c.name, outs),
        }))
        const chosen = blockedRuns.find((r) => r.verdict === 'aprovada') ?? blockedRuns[blockedRuns.length - 1]
        for (const b of blockedRuns) if (b.policy.injectCos > 1 && b.policy.pointerCos <= 1 && b.precision.total === 0) (b as { verdict: string }).verdict = 'safe (no injection)'
        const shipped = candidates.find((c) => c.name === chosen.name)!.policy

        // ---- 3. Ablations ------------------------------------------------
        // 3a. fusion: pure semantic vs hybrid, by language, on the tuning fixture
        const langMain = {
          semantic: rankingBreakdown(dataMain, main, 'eval', 'full', 'semantic', P1.retrieval),
          hybrid: rankingBreakdown(dataMain, main, 'eval', 'full', 'hybrid', P1.retrieval),
        }
        const langBlocked = {
          semantic: rankingBreakdown(dataBlocked, blocked, 'blocked', 'full', 'semantic', P1.retrieval),
          hybrid: rankingBreakdown(dataBlocked, blocked, 'blocked', 'full', 'hybrid', P1.retrieval),
        }
        // 3b. the policy's lexical path: on vs off
        const noLexPath: Policy = { ...P1b, selection: { ...P1b.selection, lexInjectCoverage: 2 } }
        const lexMain = {
          withPath: injectionPrecision(evaluatePolicy(dataMain, main, 'full', P1b.selection, P1b.useNoise, 'eval', P1b.retrieval).outs),
          withoutPath: injectionPrecision(evaluatePolicy(dataMain, main, 'full', noLexPath.selection, noLexPath.useNoise, 'eval', noLexPath.retrieval).outs),
        }
        const lexBlocked = {
          withPath: injectionPrecision(evaluatePolicy(dataBlocked, blocked, 'full', P1b.selection, P1b.useNoise, 'blocked', P1b.retrieval).outs),
          withoutPath: injectionPrecision(evaluatePolicy(dataBlocked, blocked, 'full', noLexPath.selection, noLexPath.useNoise, 'blocked', noLexPath.retrieval).outs),
        }

        // ---- 4. Dialog (message that depends on context) -----------------
        const dialogs = [
          ...main.dialogs.filter((d) => d.split === 'eval').map((d) => ({ d, data: dataMain })),
          ...blocked.dialogs.map((d) => ({ d, data: dataBlocked })),
        ]
        const dialogRows = dialogs.map(({ d, data }) => {
          const ctx = contextualQuery(d.text, d.context ?? [])
          const mode = { ...shipped.retrieval, mode: 'semantic' as const }
          const isolated = orderFor(data, 'full', d, mode)
          const contextual = orderFor(data, 'full', d, mode, { semantic: ctx.semantic, lexical: ctx.lexical })
          const ideal = orderFor(data, 'full', d, mode, { semantic: d.rewrite ?? d.text, lexical: d.rewrite ?? d.text })
          return {
            id: d.id,
            split: d.split,
            isolated: rankOfFirstRelevant(isolated, d.relevant),
            contextual: rankOfFirstRelevant(contextual, d.relevant),
            ideal: rankOfFirstRelevant(ideal, d.relevant),
          }
        })

        // ---- 5. Cases one model catches and the other does not -----------
        const caseHits = (data: ModelData, fx: ReturnType<typeof loadFixture>, split: 'eval' | 'blocked') =>
          evaluatePolicy(data, fx, 'full', shipped.selection, shipped.useNoise, split, shipped.retrieval).outs.map((o) => ({
            id: o.case.id,
            hit: o.case.relevant.length > 0 && o.injected.some((x) => o.case.relevant.includes(x)),
          }))

        const result = {
          model: id,
          loadMs: model.loadMs,
          strictInjectCos: strictCos,
          pointerFix,
          eval: evalOut.met,
          dev: devOut.met,
          confusionEval: confusion(evalOut.outs),
          precisionEval: injectionPrecision(evalOut.outs),
          aucEval: aucOnSet(evalOut.outs),
          aucBlocked: aucOnSet(blockedEvals[0].outs),
          falsePositivesEval: falsePositiveDetail(evalOut.outs),
          forensic,
          forensicBlocked: pointerForensics(P1bOuts, dataBlocked, P1b),
          falsePositivesBlocked: falsePositiveDetail(P1bOuts),
          pointerCurveDev: curveDev,
          blocked: blockedRuns,
          chosen: chosen.name,
          ablations: { langMain, langBlocked, lexMain, lexBlocked },
          dialogs: dialogRows,
          caseHits: { eval: caseHits(dataMain, main, 'eval'), blocked: caseHits(dataBlocked, blocked, 'blocked') },
          medianMs: quantile([...model.latencies].sort((a, b) => a - b), 0.5),
          p95Ms: quantile([...model.latencies].sort((a, b) => a - b), 0.95),
        }

        // ---- printing ----------------------------------------------------
        const p = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—')
        console.log(`\n================ Bekko ${id} ================`)
        console.log(`P1 on the tuning fixture (eval): injection ${result.precisionEval.correct}/${result.precisionEval.total} = ${p(result.precisionEval.precision)} IC95 [${p(result.precisionEval.ci[0])}; ${p(result.precisionEval.ci[1])}]`)
        console.log('eval matrix (expected row -> decided):')
        for (const e of EXPECT) {
          const m = result.confusionEval.matrix[e]
          console.log(`  ${e.padEnd(8)} inj=${m.inject} ptr=${m.pointer} nada=${m.none}`)
        }
        console.log('irrelevant injections:')
        for (const f of result.falsePositivesEval) console.log(`  ${f.case} (${f.expect}) injected ${f.injected} cos=${f.cos?.toFixed(3)} expected=${f.relevant.join(',') || '—'}`)
        console.log(`pointer forensics (P1 threshold = ${P1.selection.pointerCos}):`)
        for (const r of forensic) console.log(`  ${r.id} gold=${r.relevant} rank=${r.goldRank ?? '-'} cos=${r.goldCos?.toFixed(3) ?? '-'} acima=${r.nAbovePointerT} → ${r.decided}`)
        console.log('pointer forensics on the blocked set (P1b):')
        for (const r of pointerForensics(P1bOuts, dataBlocked, P1b)) console.log(`  ${r.id} gold=${r.relevant} rank=${r.goldRank ?? '-'} cos=${r.goldCos?.toFixed(3) ?? '-'} threshold=${r.pointerT} → ${r.decided}`)
        console.log(`pointer recalibrated on dev: ${pointerFix ? `cos>=${pointerFix.pointerCos} top-${pointerFix.maxPointers} (dev: ${pointerFix.devUseful} useful, ${pointerFix.devNeg} negatives)` : 'no viable point'}`)
        console.log('conjunto bloqueado (escada):')
        for (const b of blockedRuns) {
          console.log(`  ${b.name}: injection ${b.precision.correct}/${b.precision.total} ${p(b.precision.precision)} · useful pointers ${b.confusion.matrix.pointer.pointer}/${b.confusion.expected.pointer} · sem-memória tocadas ${b.confusion.matrix.none.inject + b.confusion.matrix.none.pointer}/${b.confusion.expected.none} → ${b.verdict}`)
        }
        console.log(`  ESCOLHIDA: ${chosen.name}`)
        console.log(`AUC eval ${result.aucEval.toFixed(3)} · AUC bloqueado ${result.aucBlocked.toFixed(3)}`)
        console.log(`strict injection (dev, 0 FP) = ${strictCos}`)
        console.log(`dialog: ${dialogRows.map((d) => `${d.id} isolated=${d.isolated} ctx=${d.contextual} ideal=${d.ideal}`).join(' | ')}`)

        fs.mkdirSync(OUT, { recursive: true })
        fs.writeFileSync(path.join(OUT, `audit-${id}.json`), JSON.stringify(result, null, 2))

        expect(result.confusionEval.expected.inject + result.confusionEval.expected.pointer + result.confusionEval.expected.none).toBe(evalOut.outs.length)
        expect(blockedRuns.length).toBe(3)
        expect(typeof chosen.name).toBe('string')
      },
      900_000,
    )
  }
})
