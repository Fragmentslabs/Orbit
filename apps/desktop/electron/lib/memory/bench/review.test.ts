/**
 * Ferramenta de revisão local das memórias reais (piloto de 20 cenários).
 *
 *   MEMORY_REVIEW=build npx vitest run electron/lib/memory/bench/review.test.ts
 *   MEMORY_REVIEW=eval  npx vitest run electron/lib/memory/bench/review.test.ts
 *
 * `build` sorteia o lote estratificado (50) e a amostra piloto (20), e regrava
 * `~/.orbit-memory-review/queue.json` + `revisar.html`. É idempotente: os
 * rótulos vivem no localStorage da página / no `rotulos.json`, nunca no lote.
 *
 * `eval` lê `rotulos.json`, compara a busca lexical atual (`searchMemories`,
 * a que `memory_search` usa hoje) com a híbrida (embeddings + BM25), e imprime
 * SÓ AGREGADOS. Nenhum `text`/`title`/consulta é impresso — o conteúdo do
 * acervo não sai da máquina nem entra no chat.
 *
 * PRIVACIDADE: o `queue.json` e a página contêm texto real de memória e vivem
 * fora do repositório, em ~/.orbit-memory-review/. Nunca versione esse diretório.
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
// `MEMORY_REVIEW_DIR` existe para testar o avaliador num diretório isolado,
// sem tocar nos arquivos reais de ~/.orbit-memory-review.
const OUT = process.env.MEMORY_REVIEW_DIR
  ? path.resolve(process.env.MEMORY_REVIEW_DIR)
  : path.join(os.homedir(), '.orbit-memory-review')
const MODEL_ID = process.env.MEMORY_REVIEW_MODEL === 'a25m' ? 'bekko-a25m' : 'bekko-a8m'
const MODEL_DIR = path.resolve(__dirname, `../../../../.cache/memory-embed/${MODEL_ID}`)

const RETRIEVAL = { ...DEFAULT_RETRIEVAL, semWeight: 1, lexWeight: 0.1, lexMinCoverage: 0.5 }
const POLICY: SelectionParams = {
  ...DEFAULT_SELECTION,
  threshold: 'acervo',
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
// Leitura do acervo (nunca imprime conteúdo)
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
// Build: lote de 50 + piloto de 20
// ---------------------------------------------------------------------------

function build(): void {
  const memories = readMemories()

  // Clusters de memórias parecidas (Jaccard de tokens) — só para estratificar.
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
    sim: similar.has(m.id),
  }))
  const project = meta.filter((x) => x.m.kind === 'project')
  // `core` vive no bloco fixo do prompt: nunca é recuperado, então sai do lote.
  const general = meta.filter((x) => x.m.kind !== 'project' && x.m.kind !== 'core')
  const shuffled = (a: typeof meta) => [...a].sort((x, y) => hash(x.m.id) - hash(y.m.id))

  // Lote: maioria pt, com uma franja de outros idiomas distribuída nas duas
  // partições (o acervo real tem ~16 en e ~11 sem marcador claro).
  const picks = [
    ...shuffled(project.filter((x) => x.lang === 'pt')).slice(0, 15),
    ...shuffled(general.filter((x) => x.lang === 'pt')).slice(0, 14),
    ...shuffled(project.filter((x) => x.lang !== 'pt')).slice(0, 5),
    ...shuffled(general.filter((x) => x.lang !== 'pt')).slice(0, 4),
  ]
  const seen = new Set(picks.map((x) => x.m.id))
  // Cota explícita de "parecidas": sem isso o sorteio pode não trazer nenhuma.
  const simPicks = shuffled(meta.filter((x) => x.sim && !seen.has(x.m.id))).slice(0, 2)
  for (const x of simPicks) seen.add(x.m.id)
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
    similar: x.sim,
    pilot: false,
    suggested: role === 'no-memory' ? 'none' : suggestedFor(x.m),
    text: x.m.text,
  })

  const all: Scenario[] = [
    ...picks.map((x) => mk(x, 'target')),
    ...simPicks.map((x) => mk(x, 'target')),
    ...anchors.map((x) => mk(x, 'no-memory')),
  ]

  // Piloto: cotas explícitas, pt primeiro; os cruzados entram por último para
  // não engolirem as outras cotas.
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

  // ids estáveis: renumerar na ordem do lote
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

  // O build reescreve o lote e a página — NUNCA rotulos.json. Se já houver
  // rótulos, guarda o lote anterior e avisa quantos rótulos deixariam de casar.
  const labelsPath = path.join(OUT, 'rotulos.json')
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
        `rotulos.json preservado: ${kept} rótulos casam com o lote novo${orphan ? `, ${orphan} ficaram órfãos (ids mudaram)` : ''}`,
      )
    } catch {
      console.log('rotulos.json existe mas não pôde ser lido — preservado como está')
    }
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'queue.json'), JSON.stringify(data, null, 2))

  const template = fs.readFileSync(path.join(__dirname, 'review-page.html'), 'utf8')
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  fs.writeFileSync(path.join(OUT, 'revisar.html'), template.replace('__ORBIT_DATA__', payload))

  const pilot = all.filter((s) => s.pilot)
  const pilotStrata: Record<string, number> = {}
  for (const s of pilot) {
    const k = s.role === 'no-memory' ? 'sem-memória (tema relacionado)' : `${s.kind}/${s.category}/${s.length}${s.crossLang ? '/cross' : ''}`
    pilotStrata[k] = (pilotStrata[k] ?? 0) + 1
  }
  console.log(`acervo: ${memories.length} memórias | parecidas: ${similar.size} | idiomas: ${JSON.stringify(byLang)}`)
  console.log(`categorias: ${JSON.stringify(byCat)}`)
  const nProject = all.filter((s) => s.role === 'target' && s.kind === 'project').length
  console.log(`lote: ${all.length} cenários (${nProject} project, ${all.filter((s) => s.role === 'target' && s.kind !== 'project').length} general, ${all.filter((s) => s.role === 'no-memory').length} sem-memória)`)
  console.log(`piloto: ${pilot.length} cenários`)
  for (const [k, n] of Object.entries(pilotStrata).sort()) console.log(`  ${n}× ${k}`)
  console.log(`ids do piloto: ${pilot.map((s) => s.id).join(', ')}`)
  console.log(`página: ${path.join(OUT, 'revisar.html')}`)
}

// ---------------------------------------------------------------------------
// Eval: lexical (o que memory_search faz hoje) × híbrido
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
  const labelsPath = path.join(OUT, 'rotulos.json')
  const queuePath = path.join(OUT, 'queue.json')
  if (!fs.existsSync(labelsPath)) {
    console.log('sem rotulos.json — rode o build, rotule em revisar.html e exporte para ' + labelsPath)
    return
  }
  if (!fs.existsSync(queuePath)) {
    console.log('sem queue.json — o lote não existe; rode MEMORY_REVIEW=build')
    return
  }
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as LabelsFile
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as QueueFile
  const memories = readMemories()

  // A triagem decide os denominadores. Nada aqui interpreta ausência de rótulo.
  const t = triage(labels.labels, queue.scenarios, new Set(memories.map((m) => m.id)))
  console.log(`\n=== triagem dos rótulos ===`)
  console.log(`entradas no arquivo: ${t.total}`)
  console.log(`não revisados: ${t.notInFile.length} fora do arquivo + ${t.unreviewed.length} sem consulta`)
  console.log(`inconclusivos (fora de todos os denominadores): ${t.inconclusive.length}`)
  console.log(`sem decisão (entram no ranking, saem da decisão): ${t.missingDecision.length}`)
  console.log(`descartados por dado inválido: ${t.invalidId.length} id fora do lote, ${t.invalidTarget.length} alvo fora do acervo`)
  console.log(`bases: ranking ${t.valid.length} · decisão ${t.decided.length}`)
  if (!t.valid.length) {
    console.log('nada rotulado ainda — nenhuma métrica calculada')
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
  // Um único laço: lexical e híbrido são medidos sobre exatamente os mesmos
  // cenários e o mesmo alvo (l.memoryId).
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

  console.log(`\n=== ranking (${MODEL_ID}) — mesmos ${rep.targets.n} cenários com alvo, duas rotas ===`)
  console.log(`           R@1        R@5        MRR`)
  console.log(`lexical    ${rate(Math.round(rep.targets.lexical.r1 * rep.targets.n), rep.targets.n).padEnd(10)} ${rate(Math.round(rep.targets.lexical.r5 * rep.targets.n), rep.targets.n).padEnd(10)} ${mrr(rep.targets.lexical.mrr)}`)
  console.log(`híbrido    ${rate(Math.round(rep.targets.hybrid.r1 * rep.targets.n), rep.targets.n).padEnd(10)} ${rate(Math.round(rep.targets.hybrid.r5 * rep.targets.n), rep.targets.n).padEnd(10)} ${mrr(rep.targets.hybrid.mrr)}`)
  console.log(`alvo no top-5 dos dois: ${rep.targets.both.length} · só híbrido: ${rep.targets.hybOnly.length} · só lexical: ${rep.targets.lexOnly.length} · nenhum: ${rep.targets.neither.length}`)
  if (rep.targets.hybOnly.length) console.log(`híbrido acha e lexical perde: ${rep.targets.hybOnly.join(', ')}`)
  if (rep.targets.lexOnly.length) console.log(`lexical acha e híbrido perde: ${rep.targets.lexOnly.join(', ')}`)

  console.log(`\n=== sem memória (${rep.noMemory.n}) ===`)
  console.log(`lexical devolveu algo: ${rate(rep.noMemory.lexReturned, rep.noMemory.n)}`)
  console.log(`híbrido com topo >= piso (${floor.toFixed(3)}): ${rate(rep.noMemory.hybAboveFloor, rep.noMemory.n)}`)

  console.log(`\n=== decisão esperada × política (P1, hipotética) — base ${t.decided.length} ===`)
  for (const d of rep.decision) {
    const tiers = Object.entries(d.tiers).map(([k, v]) => `${k} ${v}`).join(', ')
    console.log(`${d.expected.padEnd(8)} ${d.match}/${d.n} coincidem · ${tiers}`)
  }

  const dev = rows.filter((r) => hash(r.memoryId ?? r.id) % 2 === 0).length
  console.log(`\ndivisão por grupo de memória → dev ${dev} / eval ${rows.length - dev} (diagnóstico, não confirmação)`)

  fs.writeFileSync(
    path.join(OUT, `resultado-${MODEL_ID}.json`),
    JSON.stringify({ model: MODEL_ID, generatedAt: new Date().toISOString(), floor, triage: { ...t, valid: t.valid.length, decided: t.decided.length }, rows }, null, 2),
  )
  console.log(`detalhe por cenário (sem texto): ${path.join(OUT, `resultado-${MODEL_ID}.json`)}`)
}

/**
 * Regera **somente** `revisar.html` a partir do `queue.json` existente.
 * Não toca no lote, não toca em rótulos — serve para atualizar a interface
 * sem reamostrar cenários (o que mudaria ids e orfanaria rótulos).
 */
async function page(): Promise<void> {
  const queuePath = path.join(OUT, 'queue.json')
  if (!fs.existsSync(queuePath)) {
    console.log('sem queue.json — rode MEMORY_REVIEW=build uma vez para criar o lote')
    return
  }
  const data = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as { scenarios?: unknown[] }
  const template = fs.readFileSync(path.join(__dirname, 'review-page.html'), 'utf8')
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  fs.writeFileSync(path.join(OUT, 'revisar.html'), template.replace('__ORBIT_DATA__', payload))
  console.log(`página regerada a partir do lote existente (${data.scenarios?.length ?? 0} cenários)`)
  console.log(`arquivo: ${path.join(OUT, 'revisar.html')}`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const only = (mode: string) => (process.env.MEMORY_REVIEW === mode ? it : it.skip)

describe('revisão local das memórias reais', () => {
  only('build')('gera lote e piloto', () => build(), 120_000)
  only('page')('regera só a página', () => page(), 60_000)
  only('eval')('compara lexical × híbrido', () => evaluate(), 600_000)
})
