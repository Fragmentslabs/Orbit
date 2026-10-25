/**
 * Benchmark REAL (Fase 6): roda a solução completa com o Bekko a8m e o a25m
 * sobre as fixtures versionadas e grava o resultado em JSON.
 *
 * Fica fora da suíte normal porque carrega ~200 MB de ONNX do cache local:
 *
 *   MEMORY_BENCH=1 npx vitest run electron/lib/memory/bench/eval.test.ts
 *
 * O cache é o mesmo que o app usa (`apps/desktop/.cache/memory-embed/<id>/`:
 * `onnx/model.onnx` + `tokenizer.json`). Quem não tem o cache vê o teste
 * pulado, com a instrução de como baixar — nunca uma falha.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileTokenizer } from '../../../memory-embed/tokenizer.mjs'
import {
  calibrate,
  calibrateFusion,
  compareRules,
  contextExperiments,
  cosineDiagnostics,
  evaluatePolicy,
  percentiles,
  prepare,
  ruleSamples,
  rankingBreakdown,
  rankingExperiments,
  selectionByGroup,
  type Embed,
} from './analysis'
import { DEFAULT_RETRIEVAL, DEFAULT_SELECTION, type SelectionParams } from '@shared/memory-select'
import { orderFor as orderForCheck } from './analysis'
import { rankOfFirstRelevant as rankCheck, type BenchCase, type FixtureMemory } from './harness'

const CACHE = path.resolve(__dirname, '../../../../.cache/memory-embed')
const OUT = path.join(CACHE, 'results')
const MODELS = ['a8m', 'a25m'] as const
type ModelId = (typeof MODELS)[number]

const gated = process.env.MEMORY_BENCH ? describe : describe.skip

interface CaseRow {
  columns: string[]
  cases: unknown[][]
}

function loadFixture() {
  const dir = __dirname
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8')) as { memories: FixtureMemory[] }
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8')) as CaseRow
  const cases = raw.cases.map((row) => Object.fromEntries(raw.columns.map((c, i) => [c, row[i]])) as unknown as BenchCase)
  const dialogs = JSON.parse(fs.readFileSync(path.join(dir, 'dialogs.json'), 'utf8')) as { dialogs: BenchCase[] }
  return { memories: corpus.memories, cases, dialogs: dialogs.dialogs }
}

/** Caminhos do modelo no cache; compila o tokenizer.bin na primeira vez. */
function modelPaths(id: ModelId) {
  const dir = path.join(CACHE, `bekko-${id}`)
  const modelPath = path.join(dir, 'onnx', 'model.onnx')
  const tokenizerJson = path.join(dir, 'tokenizer.json')
  const tokenizerPath = path.join(dir, 'tokenizer.bin')
  if (!fs.existsSync(modelPath) || !fs.existsSync(tokenizerJson)) {
    throw new Error(`modelo ausente em ${dir} — baixe hotchpotch/bekko-embedding-v1-${id}`)
  }
  if (!fs.existsSync(tokenizerPath)) compileTokenizer(tokenizerJson, tokenizerPath)
  return { modelPath, tokenizerPath }
}

async function runModel(id: ModelId) {
  const fx = loadFixture()
  const { createEmbedder } = await import('../../../memory-embed/engine.mjs')
  const paths = modelPaths(id)

  const t0 = performance.now()
  const embedder = await createEmbedder({ ...paths, dim: 256 })
  const loadMs = performance.now() - t0
  const rssLoaded = process.memoryUsage().rss

  const latencies: number[] = []
  const embed: Embed = async (texts) => {
    const out: Float32Array[] = []
    for (const text of texts) {
      const t = performance.now()
      const [vec] = await embedder.embed([text])
      latencies.push(performance.now() - t)
      out.push(vec)
    }
    return out
  }

  const data = await prepare(embed, fx)
  const rssIndexed = process.memoryUsage().rss

  const fusion = calibrateFusion(data, fx, 'full')
  // A fusão escolhida é a melhor entre os pesos COM apoio lexical (a lista
  // lexical é o que sustenta identificador e nome próprio que o embedding não
  // isola). O caso lexWeight=0 fica na tabela como ablação, não como escolha.
  const withLex = fusion.filter((f) => f.lexWeight > 0 && f.lexMinCoverage > 0)
  const fusionChoice = withLex[0] ?? fusion[0]
  const retrieval = {
    ...DEFAULT_RETRIEVAL,
    semWeight: 1,
    lexWeight: fusionChoice.lexWeight,
    lexMinCoverage: fusionChoice.lexMinCoverage,
  }
  const ranking = rankingExperiments(data, fx, retrieval)
  const diag = cosineDiagnostics(data, fx, 'full')
  const rules = ruleSamples(data, fx, 'full')
  const breakdown = rankingBreakdown(data, fx, 'eval', 'full', 'hybrid', retrieval)
  // O recorte por categoria TEM de fechar com a linha calibrada do ranking —
  // já aconteceu de a tabela de recorte ficar presa na fusão ingênua.
  {
    const pos = fx.cases.filter((c) => c.relevant.length && c.split === 'eval')
    const calibratedTop1 = pos.filter((c) => rankCheck(orderForCheck(data, 'full', c, retrieval), c.relevant) === 1).length
    const row = ranking.find((x) => x.name === 'híbrido RRF, fusão calibrada' && x.split === 'eval')
    if (row && Math.round(row.m.hit1 * pos.length) !== calibratedTop1) {
      throw new Error(
        `recorte dessincronizado: ranking diz ${Math.round(row.m.hit1 * pos.length)}/${pos.length}, recalculo diz ${calibratedTop1}/${pos.length}`,
      )
    }
  }
  // Calibra SÓ no split dev e escolhe a família com melhor pontuação ali.
  const calibrated = calibrate(data, fx, 'full', 2, retrieval)
  const best = calibrated
    .filter((c) => c.best)
    .sort((a, b) => (b.best!.score ?? 0) - (a.best!.score ?? 0))[0]
  const policy = (best?.best?.params ?? DEFAULT_SELECTION) as SelectionParams
  const useNoise = best?.family.startsWith('C.') || best?.family.startsWith('D.')
  const devMet = evaluatePolicy(data, fx, 'full', policy, useNoise, 'dev', retrieval)
  const evalMet = evaluatePolicy(data, fx, 'full', policy, useNoise, 'eval', retrieval)
  const contexts = contextExperiments(data, fx, 'full', policy, useNoise, retrieval)

  // Recorte de seleção por idioma e por tipo de memória (só eval).
  const memById = new Map(fx.memories.map((m) => [m.id, m]))
  const byLang: Record<string, { inj: number; fp: number; ptr: number; none: number }> = {}
  for (const o of evalMet.outs) {
    const key = o.case.lang
    const bucket = (byLang[key] ??= { inj: 0, fp: 0, ptr: 0, none: 0 })
    bucket.inj += o.injected.length
    bucket.ptr += o.pointers.length
    bucket.fp += o.injected.filter((mid) => !o.case.relevant.includes(mid)).length
    if (!o.injected.length && !o.pointers.length) bucket.none++
  }

  // Seleção recortada por idioma da memória vs idioma da consulta. É a checagem
  // que importa para multilíngue: a cobertura lexical (que só ACRESCENTA
  // caminho de injeção, nunca bloqueia) não pode estar derrubando o caso cruzado.
  const evalCases = fx.cases.filter((c) => c.split === 'eval')
  const selByCross = selectionByGroup(evalMet.outs, evalCases, (c) => {
    if (!c.relevant.length) return 'sem memória necessária'
    const mem = memById.get(c.relevant[0])
    return mem && mem.lang !== c.lang ? 'idioma diferente' : 'mesmo idioma'
  })

  // Sensibilidade ao split: calibra no "eval" e mede no "dev". Se o sentido
  // inverso escolher limiares parecidos e mantiver o desempenho, o resultado
  // não é artefato de um conjunto específico.
  const calibratedSwap = calibrate(data, fx, 'full', 2, retrieval, 'eval')
  const bestSwap = calibratedSwap
    .filter((c) => c.best)
    .sort((a, b) => (b.best!.score ?? 0) - (a.best!.score ?? 0))[0]
  const swapPolicy = (bestSwap?.best?.params ?? DEFAULT_SELECTION) as SelectionParams
  const swapUseNoise = bestSwap?.family.startsWith('C.') || bestSwap?.family.startsWith('D.')
  const swapMet = evaluatePolicy(data, fx, 'full', swapPolicy, swapUseNoise, 'dev', retrieval)
  const swap = {
    family: bestSwap?.family ?? null,
    params: swapPolicy,
    inj: swapMet.met.injectCasesHit,
    injectCases: swapMet.met.injectCases,
    fp: swapMet.met.falsePositives,
    ptr: swapMet.met.pointerCasesPointer,
    pointerCases: swapMet.met.pointerCases,
  }

  latencies.sort((a, b) => a - b)
  const pct = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0

  const result = {
    model: id,
    loadMs,
    rssLoadedMB: Math.round(rssLoaded / 1e6),
    rssIndexedMB: Math.round(rssIndexed / 1e6),
    indexMsPerMemory: ranking.length ? null : null,
    queries: latencies.length,
    medianMs: +pct(0.5).toFixed(2),
    p95Ms: +pct(0.95).toFixed(2),
    calibrated: calibrated.map((c) => ({
      family: c.family,
      params: c.best?.params ?? null,
      dev: c.best?.met ?? null,
    })),
    chosenPolicy: { family: best?.family ?? null, useNoise, params: policy },
    dev: devMet.met,
    eval: evalMet.met,
    byLang,
    selByCross,
    swap,
    contexts,
    ranking,
    breakdown,
    fusion,
    retrieval,
    diag,
    rulesDev: compareRules(rules, 'dev'),
    rulesEval: compareRules(rules, 'eval'),
    cosines: {
      'inject (dev)': percentiles(diag.filter((d) => d.expect === 'inject' && d.split === 'dev').map((d) => d.gold ?? -1)),
      'inject (eval)': percentiles(diag.filter((d) => d.expect === 'inject' && d.split === 'eval').map((d) => d.gold ?? -1)),
      'none: topo (dev)': percentiles(diag.filter((d) => d.expect === 'none' && d.split === 'dev').map((d) => d.top)),
      'none: topo (eval)': percentiles(diag.filter((d) => d.expect === 'none' && d.split === 'eval').map((d) => d.top)),
      'pointer (dev)': percentiles(diag.filter((d) => d.expect === 'pointer' && d.split === 'dev').map((d) => d.gold ?? -1)),
      'piso de ruído (sondas)': percentiles(data.noise.full.tops),
    },
    memoryTypes: Object.fromEntries(
      fx.memories.map((m) => [m.id, { type: m.type, lang: m.lang }]),
    ),
    unused: memById.size,
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `bekko-${id}.json`), JSON.stringify(result, null, 2))
  await embedder.dispose()
  return result
}

gated('benchmark Bekko (real)', () => {
  const fx = loadFixture()

  it('o fixture é coerente (ids, splits, idiomas)', () => {
    const ids = new Set(fx.memories.map((m) => m.id))
    for (const c of [...fx.cases, ...fx.dialogs]) for (const r of c.relevant) expect(ids.has(r)).toBe(true)
    expect(fx.cases.filter((c) => c.split === 'dev').length).toBeGreaterThan(40)
    expect(fx.cases.filter((c) => c.split === 'eval').length).toBeGreaterThan(40)
    expect(new Set(fx.memories.map((m) => m.lang)).size).toBeGreaterThanOrEqual(4)
  })

  for (const id of MODELS) {
    it(
      `roda ${id}`,
      async () => {
        const r = await runModel(id)
        const row = (name: string) => r.ranking.find((x) => x.name === name && x.split === 'eval')!
        console.log(
          [
            `\n### Bekko ${id}`,
            `carregar ${Math.round(r.loadMs)} ms · RSS ${r.rssLoadedMB} MB (modelo) / ${r.rssIndexedMB} MB (índice) · consulta ${r.medianMs} ms (p95 ${r.p95Ms})`,
            '',
            '| experimento | R@1 | R@3 | R@5 | MRR | AUC |',
            '|---|---|---|---|---|---|',
            ...r.ranking
              .filter((x) => x.split === 'eval')
              .map(
                (x) =>
                  `| ${x.name} | ${(x.m.hit1 * 100).toFixed(1)}% | ${(x.m.hit3 * 100).toFixed(1)}% | ${(x.m.hit5 * 100).toFixed(1)}% | ${x.m.mrr.toFixed(3)} | ${Number.isNaN(x.auc) ? '—' : x.auc.toFixed(3)} |`,
              ),
            '',
            `pesos da fusão (dev): ${r.fusion.map((f) => `lex ${f.lexWeight}/cov ${f.lexMinCoverage}→R@1 ${(f.hit1 * 100).toFixed(1)}%`).join(' · ')}`,
            '',
            '| cossenos | p10 | p25 | p50 | p75 | p90 | max |',
            '|---|---|---|---|---|---|---|',
            ...Object.entries(r.cosines).map(
              ([name, p]: [string, Record<string, number>]) =>
                `| ${name} | ${p.p10} | ${p.p25} | ${p.p50} | ${p.p75} | ${p.p90} | ${p.p100} |`,
            ),
            '',
            '| regra (dev) | injetou | FP | FP tema vizinho |',
            '|---|---|---|---|',
            ...r.rulesDev.map(
              (x: { rule: string; injectHit: number; injectN: number; falsePos: number; negN: number; falsePosRel: number; relN: number }) =>
                `| ${x.rule} | ${x.injectHit}/${x.injectN} | ${x.falsePos}/${x.negN} | ${x.falsePosRel}/${x.relN} |`,
            ),
            '',
            `política escolhida: ${String(r.chosenPolicy.family)}`,
            `dev: injetou ${r.dev.injectCasesHit}/${r.dev.injectCases} · FP ${r.dev.falsePositives} · ponteiros úteis ${r.dev.pointerCasesPointer}/${r.dev.pointerCases} · limpas ${r.dev.negClean}/${r.dev.negatives}`,
            `eval: injetou ${r.eval.injectCasesHit}/${r.eval.injectCases} · FP ${r.eval.falsePositives} · ponteiros úteis ${r.eval.pointerCasesPointer}/${r.eval.pointerCases} · limpas ${r.eval.negClean}/${r.eval.negatives}`,
            `  (eval: ${r.eval.positives} positivos + ${r.eval.negatives} negativos = ${r.eval.positives + r.eval.negatives} consultas; ${r.eval.injectedTotal} memórias injetadas, ${r.eval.relevantInjected}/${r.eval.relevantTotal} das necessárias)`,
            '',
            '| seleção no eval (eval) | injetou | FP | ponteiro útil | limpas |',
            '|---|---|---|---|---|',
            ...r.selByCross.map(
              (g: { group: string; n: number; met: { injectCasesHit: number; injectCases: number; falsePositives: number; pointerCasesPointer: number; pointerCases: number; negClean: number; negatives: number } }) =>
                `| ${g.group} (n=${g.n}) | ${g.met.injectCasesHit}/${g.met.injectCases} | ${g.met.falsePositives} | ${g.met.pointerCasesPointer}/${g.met.pointerCases} | ${g.met.negClean}/${g.met.negatives} |`,
            ),
            '',
            `sensibilidade ao split (calibrado no eval, medido no dev): ${String(r.swap.family)} → injetou ${r.swap.inj}/${r.swap.injectCases} · FP ${r.swap.fp} · ponteiros úteis ${r.swap.ptr}/${r.swap.pointerCases}`,
            '',
            '| contexto | top1 | injetou | ponteiros | limpas |',
            '|---|---|---|---|---|',
            ...Object.entries(r.contexts).map(
              ([name, m]) => `| ${name} | ${m.top1}/${m.n} | ${m.injectCasesHit}/${m.injectCases} | ${m.pointerCasesPointer}/${m.pointerCases} | ${m.negClean}/${m.negatives} |`,
            ),
            '',
            '| recorte | R@1 | R@5 | n |',
            '|---|---|---|---|',
            ...Object.entries(r.breakdown).flatMap(([group, byKey]) =>
              Object.entries(byKey as Record<string, { hit1: number; hit5: number; n: number }>).map(
                ([key, m]) => `| ${group}: ${key} | ${(m.hit1 * 100).toFixed(0)}% | ${(m.hit5 * 100).toFixed(0)}% | ${m.n} |`,
              ),
            ),
            row('híbrido RRF, enriquecida (com LLM)') ? '' : '',
          ].join('\n'),
        )
        expect(r.queries).toBeGreaterThan(100)
      },
      600_000,
    )
  }
})
