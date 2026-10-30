/**
 * Local review tool for the real memories (pilot of 20 scenarios).
 *
 *   MEMORY_REVIEW=build npx vitest run electron/lib/memory/bench/review.test.ts
 *   MEMORY_REVIEW=eval  npx vitest run electron/lib/memory/bench/review.test.ts
 *
 * `build` draws the stratified batch (50) and the pilot sample (20), and rewrites
 * `~/.orbit-memory-review/queue.json` + `review.html`. It is idempotent: the
 * labels live in the page's localStorage / in `labels.json`, never in the batch.
 *
 * `eval` reads `labels.json`, compares the current lexical search (`searchMemories`,
 * the one `memory_search` uses today) with the hybrid one (embeddings + BM25), and prints
 * ONLY AGGREGATES. No `text`/`title`/query is printed — the content of the
 * pool does not leave the machine nor enter the chat.
 *
 * PRIVACY: `queue.json` and the page contain real memory text and live
 * outside the repository, in ~/.orbit-memory-review/. Never version that directory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'
import { createEmbedder } from '../../../memory-embed/engine.mjs'
import { Bm25Index, buildRetrievalText, lexicalDocOf } from '@shared/memory-retrieval'
import {
  DEFAULT_RETRIEVAL,
  DEFAULT_SELECTION,
  NOISE_PROBES,
  noiseFloorOf,
  quantile,
  retrieveCandidates,
  selectForContext,
  type SelectionParams,
} from '@shared/memory-select'
import { searchMemories, type Memory } from '@shared/memory'
import { summarize, triage, type RankRow } from './pilot-metrics'

const ITEMS = path.join(os.homedir(), 'Library/Application Support/@orbit/desktop/orbit-data/storage/memory/items')
// `MEMORY_REVIEW_DIR` exists to test the evaluator in an isolated directory,
// without touching the real files in ~/.orbit-memory-review.
const OUT = process.env.MEMORY_REVIEW_DIR
  ? path.resolve(process.env.MEMORY_REVIEW_DIR)
  : path.join(os.homedir(), '.orbit-memory-review')
/**
 * The label file. `rotulos.json` is the name it had before the standard was English:
 * whoever labeled with the old page keeps the labels where they are.
 */
function existingLabelsPath(): string {
  const current = path.join(OUT, 'labels.json')
  if (fs.existsSync(current)) return current
  return path.join(OUT, 'rotulos.json')
}
const MODEL_ID = process.env.MEMORY_REVIEW_MODEL === 'a25m' ? 'bekko-a25m' : 'bekko-a8m'
const MODEL_DIR = path.resolve(__dirname, `../../../../.cache/memory-embed/${MODEL_ID}`)

const RETRIEVAL = { ...DEFAULT_RETRIEVAL, semWeight: 1, lexWeight: 0.1, lexMinCoverage: 0.5 }
const POLICY: SelectionParams = {
  ...DEFAULT_SELECTION,
  threshold: 'collection',
  noiseQuantile: 1,
  injectDelta: 0.22,
  pointerDelta: 0,
  lexInjectCoverage: 0.7,
  maxInject: 3,
  maxPointers: 2,
  gap: 0.1,
  maxInjectChars: 600,
}

// ---------------------------------------------------------------------------
// Reading the pool (never prints content)
// ---------------------------------------------------------------------------

function readMemories(): Memory[] {
  const files = fs.readdirSync(ITEMS).filter((f) => f.endsWith('.json'))
  const out: Memory[] = []
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(ITEMS, f), 'utf8'))
    for (const m of Array.isArray(raw) ? raw : [raw]) if (m?.text) out.push(m as Memory)
  }
  return out
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const PT = new Set('que para com não uma dos das por mais como você mas já foi ser tem aqui quando porque também só muito bem isso isso'.split(' '))
const EN = new Set('the and that with this from have not but are was for you can will when which there about just what your'.split(' '))
const ES = new Set('que los las por para con una del pero más como sus cuando porque también muy sin sobre este esta'.split(' '))

function detectLang(text: string): 'pt' | 'en' | 'es' | 'ja' | 'ru' | 'other' {
  if (/[\u3040-\u30ff\u4e00-\u9aff]/.test(text)) return 'ja'
  if (/[\u0400-\u04ff]/.test(text)) return 'ru'
  const tokens = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean)
  let pt = 0
  let en = 0
  let es = 0
  for (const t of tokens) {
    if (PT.has(t)) pt++
    if (EN.has(t)) en++
    if (ES.has(t)) es++
  }
  const best = Math.max(pt, en, es)
  if (best === 0) return 'other'
  if (best === pt) return 'pt'
  if (best === en) return 'en'
  return 'es'
}

const tokensOf = (s: string) =>
  new Set(s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2))

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union ? inter / union : 0
}

interface Scenario {
  id: string
  memoryId: string | null
  role: 'target' | 'no-memory'
  kind: string
  category: string
  area: string
  lang: string
  crossLang: boolean
  length: 'short' | 'medium' | 'long'
  similar: boolean
  pilot: boolean
  suggested: 'inject' | 'pointer' | 'none' | 'unclear'
  text: string
}

function lengthBucket(text: string): Scenario['length'] {
  if (text.length <= 160) return 'short'
  if (text.length <= 420) return 'medium'
  return 'long'
}

function suggestedFor(m: Memory): Scenario['suggested'] {
  const c = (m.category ?? '').toLowerCase()
  if (c === 'preference' || c === 'standard') return 'inject'
  if (c === 'structure' || c === 'context') return 'pointer'
  if (c === 'decision' || c === 'convention' || c === 'database') return 'inject'
  return 'unclear'
}

// ---------------------------------------------------------------------------
// Build: batch of 50 + pilot of 20
// ---------------------------------------------------------------------------

function build(): void {
  const memories = readMemories()

  // Clusters of similar memories (token Jaccard) — only to stratify.
  const toks = new Map(memories.map((m) => [m.id, tokensOf(m.text)]))
  const similar = new Set<string>()
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      if (jaccard(toks.get(memories[i].id)!, toks.get(memories[j].id)!) > 0.3) {
        similar.add(memories[i].id)
        similar.add(memories[j].id)
      }
    }
  }

  const meta = memories.map((m) => ({
    m,
    lang: detectLang(m.text),
    len: lengthBucket(m.text),
    isSimilar: similar.has(m.id),
  }))
  const project = meta.filter((x) => x.m.kind === 'project')
  // `core` lives in the fixed prompt block: it is never retrieved, so it leaves the batch.
  const general = meta.filter((x) => x.m.kind !== 'project' && x.m.kind !== 'core')
  const shuffled = (a: typeof meta) => [...a].sort((x, y) => hash(x.m.id) - hash(y.m.id))

  // Batch: mostly pt, with a fringe of other languages spread over both
  // partitions (the real pool has ~16 en and ~11 with no clear marker).
  const picks = [
    ...shuffled(project.filter((x) => x.lang === 'pt')).slice(0, 15),
    ...shuffled(general.filter((x) => x.lang === 'pt')).slice(0, 14),
    ...shuffled(project.filter((x) => x.lang !== 'pt')).slice(0, 5),
    ...shuffled(general.filter((x) => x.lang !== 'pt')).slice(0, 4),
  ]
  const seen = new Set(picks.map((x) => x.m.id))
  // Explicit quota of "similar": without it the draw may bring none.
  const similarPicks = shuffled(meta.filter((x) => x.isSimilar && !seen.has(x.m.id))).slice(0, 2)
  for (const x of similarPicks) seen.add(x.m.id)
  const anchors = shuffled(meta.filter((x) => !seen.has(x.m.id))).slice(0, 10)

  const mk = (x: (typeof meta)[number], role: Scenario['role']): Scenario => ({
    id: '',
    memoryId: x.m.id,
    role,
    kind: x.m.kind ?? '-',
    category: x.m.category ?? '-',
    area: x.m.area ?? '-',
    lang: x.lang,
    crossLang: x.lang !== 'pt',
    length: x.len,
    similar: x.isSimilar,
    pilot: false,
    suggested: role === 'no-memory' ? 'none' : suggestedFor(x.m),
    text: x.m.text,
  })

  const all: Scenario[] = [
    ...picks.map((x) => mk(x, 'target')),
    ...similarPicks.map((x) => mk(x, 'target')),
    ...anchors.map((x) => mk(x, 'no-memory')),
  ]

  // Pilot: explicit quotas, pt first; the cross-language ones come in last so they do not
  // swallow the other quotas.
  const pickInto = (pred: (s: Scenario) => boolean, n: number, preferPt = true) => {
    const pool = all
      .filter((s) => !s.pilot && pred(s))
      .sort((a, b) => (preferPt ? (a.crossLang ? 1 : 0) - (b.crossLang ? 1 : 0) : 0) || hash(a.id + a.memoryId!) - hash(b.id + b.memoryId!))
    for (const s of pool) {
      if (n <= 0) break
      s.pilot = true
      n--
    }
  }

  pickInto((s) => s.role === 'target' && s.kind === 'project' && s.length === 'short', 2)
  pickInto((s) => s.role === 'target' && s.kind === 'project' && s.length === 'long', 2)
  pickInto((s) => s.role === 'target' && s.similar, 2)
  pickInto((s) => s.role === 'target' && s.category === 'preference', 2)
  pickInto((s) => s.role === 'target' && s.category === 'learning', 1)
  pickInto((s) => s.role === 'target' && ['decision', 'convention', 'structure', 'database'].includes(s.category), 2)
  pickInto((s) => s.role === 'no-memory', 5)
  pickInto((s) => s.role === 'target' && s.crossLang, 3, false)
  pickInto(() => true, Math.max(0, 20 - all.filter((s) => s.pilot).length))

  // stable ids: renumber in batch order
  all.forEach((s, i) => {
    s.id = `sc${String(i + 1).padStart(2, '0')}`
  })

  const byKind: Record<string, number> = {}
  const byLang: Record<string, number> = {}
  for (const m of memories) {
    byKind[m.kind ?? '-'] = (byKind[m.kind ?? '-'] ?? 0) + 1
  }
  for (const x of meta) byLang[x.lang] = (byLang[x.lang] ?? 0) + 1
  const byCat: Record<string, number> = {}
  for (const m of memories) byCat[m.category ?? '-'] = (byCat[m.category ?? '-'] ?? 0) + 1

  const data = {
    v: 2,
    generatedAt: new Date().toISOString(),
    corpus: { count: memories.length, byKind, byLang, similarPairs: similar.size },
    scenarios: all,
  }

  // The build rewrites the batch and the page — NEVER labels.json. If there are already
  // labels, it keeps the previous batch and warns how many labels would stop matching.
  const labelsPath = existingLabelsPath()
  if (fs.existsSync(labelsPath)) {
    const prevQueue = path.join(OUT, 'queue.json')
    if (fs.existsSync(prevQueue)) fs.copyFileSync(prevQueue, path.join(OUT, 'queue.anterior.json'))
    try {
      const prev = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as LabelsFile
      const nextIds = new Set(all.map((s) => s.id))
      const prevIds = (prev.labels ?? []).map((l) => l.id)
      const kept = prevIds.filter((id) => nextIds.has(id)).length
      const orphan = prevIds.length - kept
      console.log(
        `labels.json preserved: ${kept} labels match the new batch${orphan ? `, ${orphan} were orphaned (ids changed)` : ''}`,
      )
    } catch {
      console.log('labels.json exists but could not be read — preserved as is')
    }
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'queue.json'), JSON.stringify(data, null, 2))

  const template = fs.readFileSync(path.join(__dirname, 'review-page.html'), 'utf8')
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  fs.writeFileSync(path.join(OUT, 'review.html'), template.replace('__ORBIT_DATA__', payload))

  const pilot = all.filter((s) => s.pilot)
  const pilotStrata: Record<string, number> = {}
  for (const s of pilot) {
    const k = s.role === 'no-memory' ? 'no-memory (related topic)' : `${s.kind}/${s.category}/${s.length}${s.crossLang ? '/cross' : ''}`
    pilotStrata[k] = (pilotStrata[k] ?? 0) + 1
  }
  console.log(`corpus: ${memories.length} memories | similar: ${similar.size} | languages: ${JSON.stringify(byLang)}`)
  console.log(`categories: ${JSON.stringify(byCat)}`)
  const nProject = all.filter((s) => s.role === 'target' && s.kind === 'project').length
  console.log(`batch: ${all.length} scenarios (${nProject} project, ${all.filter((s) => s.role === 'target' && s.kind !== 'project').length} general, ${all.filter((s) => s.role === 'no-memory').length} no-memory)`)
  console.log(`pilot: ${pilot.length} scenarios`)
  for (const [k, n] of Object.entries(pilotStrata).sort()) console.log(`  ${n}× ${k}`)
  console.log(`pilot ids: ${pilot.map((s) => s.id).join(', ')}`)
  console.log(`page: ${path.join(OUT, 'review.html')}`)
}

// ---------------------------------------------------------------------------
// Eval: lexical (what memory_search does today) vs hybrid
// ---------------------------------------------------------------------------

interface QueueFile {
  scenarios: Array<{ id: string; memoryId: string | null; role: string }>
}

interface LabelsFile {
  labels: Array<{
    id: string
    memoryId: string | null
    role: string
    pilot?: boolean
    query: string
    context: string
    decision: string
    reason: string
  }>
}

async function evaluate(): Promise<void> {
  const labelsPath = existingLabelsPath()
  const queuePath = path.join(OUT, 'queue.json')
  if (!fs.existsSync(labelsPath)) {
    console.log(`no labels.json — run the build, label in review.html and export to ${path.join(OUT, 'labels.json')}`)
    return
  }
  if (!fs.existsSync(queuePath)) {
    console.log('no queue.json — the batch does not exist; run MEMORY_REVIEW=build')
    return
  }
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as LabelsFile
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as QueueFile
  const memories = readMemories()

  // The triage decides the denominators. Nothing here interprets the absence of a label.
  const t = triage(labels.labels, queue.scenarios, new Set(memories.map((m) => m.id)))
  console.log(`\n=== label triage ===`)
  console.log(`entries in the file: ${t.total}`)
  console.log(`not reviewed: ${t.notInFile.length} outside the file + ${t.unreviewed.length} with no query`)
  console.log(`inconclusive (out of every denominator): ${t.inconclusive.length}`)
  console.log(`no decision (they enter the ranking, leave the decision): ${t.missingDecision.length}`)
  console.log(`discarded for invalid data: ${t.invalidId.length} ids outside the batch, ${t.invalidTarget.length} targets outside the corpus`)
  console.log(`bases: ranking ${t.valid.length} · decision ${t.decided.length}`)
  if (!t.valid.length) {
    console.log('nothing labeled yet — no metric computed')
    return
  }

  const embedder = await createEmbedder({
    modelPath: path.join(MODEL_DIR, 'onnx', 'model.onnx'),
    tokenizerPath: path.join(MODEL_DIR, 'tokenizer.bin'),
    dim: 256,
    maxTokens: 512,
  })
  const vectors = await embedder.embed(memories.map((m) => buildRetrievalText(m)))
  const vecMap = new Map(memories.map((m, i) => [m.id, vectors[i]]))
  const lexical = new Bm25Index(memories.map((m) => lexicalDocOf(m)))
  const noise = noiseFloorOf(await embedder.embed(NOISE_PROBES), vecMap)
  const floor = quantile(noise.tops, POLICY.noiseQuantile)

  const rows: RankRow[] = []
  // A single loop: lexical and hybrid are measured over exactly the same
  // scenarios and the same target (l.memoryId).
  for (const l of t.valid) {
    const lex = searchMemories(memories, l.query!, 8)
    const lexRank = l.memoryId ? lex.findIndex((m) => m.id === l.memoryId) + 1 || null : null

    const qv = (await embedder.embed([l.query!]))[0]
    const cands = retrieveCandidates({ queryVec: qv, lexicalQuery: l.query!, vectors: vecMap, lexical }, RETRIEVAL)
    const hybRank = l.memoryId ? cands.findIndex((c) => c.id === l.memoryId) + 1 || null : null
    const hybTopCos = cands.find((c) => c.cos != null)?.cos ?? null

    const sel = selectForContext(cands, noise, POLICY)
    const tier = sel.inject.length ? 'inject' : sel.pointers.length ? 'pointer' : 'none'

    rows.push({
      id: l.id,
      role: l.role ?? 'target',
      memoryId: l.memoryId,
      lexRank,
      hybRank,
      lexHits: lex.length,
      hybTopCos,
      tier,
      decision: (l.decision ?? '').trim(),
    })
  }

  const rep = summarize(rows, floor)
  const rate = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : '—/—')
  const mrr = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—')

  console.log(`\n=== ranking (${MODEL_ID}) — the same ${rep.targets.n} scenarios with a target, two routes ===`)
  console.log(`           R@1        R@5        MRR`)
  console.log(`lexical    ${rate(Math.round(rep.targets.lexical.r1 * rep.targets.n), rep.targets.n).padEnd(10)} ${rate(Math.round(rep.targets.lexical.r5 * rep.targets.n), rep.targets.n).padEnd(10)} ${mrr(rep.targets.lexical.mrr)}`)
  console.log(`hybrid     ${rate(Math.round(rep.targets.hybrid.r1 * rep.targets.n), rep.targets.n).padEnd(10)} ${rate(Math.round(rep.targets.hybrid.r5 * rep.targets.n), rep.targets.n).padEnd(10)} ${mrr(rep.targets.hybrid.mrr)}`)
  console.log(`target in the top-5 of both: ${rep.targets.both.length} · hybrid only: ${rep.targets.hybOnly.length} · lexical only: ${rep.targets.lexOnly.length} · neither: ${rep.targets.neither.length}`)
  if (rep.targets.hybOnly.length) console.log(`hybrid finds it and lexical loses it: ${rep.targets.hybOnly.join(', ')}`)
  if (rep.targets.lexOnly.length) console.log(`lexical finds it and hybrid loses it: ${rep.targets.lexOnly.join(', ')}`)

  console.log(`\n=== no memory (${rep.noMemory.n}) ===`)
  console.log(`lexical returned something: ${rate(rep.noMemory.lexReturned, rep.noMemory.n)}`)
  console.log(`hybrid with top >= floor (${floor.toFixed(3)}): ${rate(rep.noMemory.hybAboveFloor, rep.noMemory.n)}`)

  console.log(`\n=== expected decision × policy (P1, hypothetical) — base ${t.decided.length} ===`)
  for (const d of rep.decision) {
    const tiers = Object.entries(d.tiers).map(([k, v]) => `${k} ${v}`).join(', ')
    console.log(`${d.expected.padEnd(8)} ${d.match}/${d.n} agree · ${tiers}`)
  }

  const dev = rows.filter((r) => hash(r.memoryId ?? r.id) % 2 === 0).length
  console.log(`\nsplit by memory group → dev ${dev} / eval ${rows.length - dev} (diagnostic, not confirmation)`)

  fs.writeFileSync(
    path.join(OUT, `result-${MODEL_ID}.json`),
    JSON.stringify({ model: MODEL_ID, generatedAt: new Date().toISOString(), floor, triage: { ...t, valid: t.valid.length, decided: t.decided.length }, rows }, null, 2),
  )
  console.log(`detail per scenario (no text): ${path.join(OUT, `result-${MODEL_ID}.json`)}`)
}

/**
 * Regenerates **only** `review.html` from the existing `queue.json`.
 * It does not touch the batch, does not touch labels — it serves to update the interface
 * without resampling scenarios (which would change ids and orphan labels).
 */
async function page(): Promise<void> {
  const queuePath = path.join(OUT, 'queue.json')
  if (!fs.existsSync(queuePath)) {
    console.log('no queue.json — run MEMORY_REVIEW=build once to create the batch')
    return
  }
  const data = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as { scenarios?: unknown[] }
  const template = fs.readFileSync(path.join(__dirname, 'review-page.html'), 'utf8')
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  fs.writeFileSync(path.join(OUT, 'review.html'), template.replace('__ORBIT_DATA__', payload))
  console.log(`page regenerated from the existing batch (${data.scenarios?.length ?? 0} scenarios)`)
  console.log(`file: ${path.join(OUT, 'review.html')}`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const only = (mode: string) => (process.env.MEMORY_REVIEW === mode ? it : it.skip)

describe('local review of the real memories', () => {
  only('build')('builds the batch and the pilot', () => build(), 120_000)
  only('page')('regenerates the page only', () => page(), 60_000)
  only('eval')('compares lexical × hybrid', () => evaluate(), 600_000)
})
