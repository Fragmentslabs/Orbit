/**
 * JSON evaluation of the real pool — no page, no interface.
 *
 *   MEMORY_REVIEW_JSON=gen   npx vitest run electron/lib/memory/bench/review-json.test.ts
 *   MEMORY_REVIEW_JSON=score npx vitest run electron/lib/memory/bench/review-json.test.ts
 *
 * `gen` assembles ~23 queries from the real memories, runs the lexical and
 * the hybrid search over exactly the same queries and writes a local JSON for
 * review, plus a short guide. `score` reads the classifications and compares the two
 * mechanisms.
 *
 * Files: `query-review.json`, `HOW-TO-LABEL.md` and `review-result.json`. A
 * review started before the English rename lives in `avaliacao-consultas.json`
 * — while only that one exists it is the one read and scored, and the reader
 * still accepts its Portuguese keys.
 *
 * PRIVACY: the memory text goes ONLY to the local JSON file. This
 * runner prints counts, ids and metrics — never `text`, `title` or `summary`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'vitest'
import { createEmbedder } from '../../../memory-embed/engine.mjs'
import { Bm25Index, buildRetrievalText, lexicalDocOf } from '@shared/memory-retrieval'
import { DEFAULT_RETRIEVAL, retrieveCandidates } from '@shared/memory-select'
import { scoreMemory, searchMemories, tokenize, type Memory } from '@shared/memory'
import { OUT, readMemories } from './local-corpus'
import {
  compareMechanisms,
  parseQueries,
  scoreMechanism,
  scoreNoMemory,
} from './review-json-metrics'

const MODEL = path.resolve(__dirname, '../../../../.cache/memory-embed/bekko-a8m')

/** Same retrieval parameters as the benchmark (a8m, calibrated on dev). */
const RETRIEVAL = { ...DEFAULT_RETRIEVAL, semWeight: 1, lexWeight: 0.1, lexMinCoverage: 0.5 }

const LEGACY_JSON_PATH = path.join(OUT, 'avaliacao-consultas.json')
const CURRENT_JSON_PATH = path.join(OUT, 'query-review.json')
const JSON_PATH =
  !fs.existsSync(CURRENT_JSON_PATH) && fs.existsSync(LEGACY_JSON_PATH) ? LEGACY_JSON_PATH : CURRENT_JSON_PATH
const GUIDE_PATH = path.join(OUT, 'HOW-TO-LABEL.md')
const RESULT_PATH = path.join(OUT, 'review-result.json')

type QueryType =
  | 'decision'
  | 'convention'
  | 'learning'
  | 'project'
  | 'preference'
  | 'short'
  | 'ambiguous'
  | 'other_language'
  | 'no_memory'

interface Draft {
  type: QueryType
  language: 'pt' | 'en'
  text: string
  expected: 'retrieve' | 'none'
  derivedFrom: string | null
}

const TEMPLATES: Record<string, { pt: string; en: string }> = {
  decision: { pt: 'Qual foi a decisão sobre {t}?', en: 'What did we decide about {t}?' },
  convention: { pt: 'Qual convenção a gente segue para {t}?', en: 'Which convention do we follow for {t}?' },
  learning: { pt: 'O que eu aprendi sobre {t}?', en: 'What did I learn about {t}?' },
  structure: { pt: 'Como está organizado {t}?', en: 'How is {t} organized?' },
  preference: { pt: 'Como eu prefiro {t}?', en: 'How do I prefer {t}?' },
  standard: { pt: 'Qual é o padrão para {t}?', en: "What's the standard for {t}?" },
  default: { pt: 'O que você sabe sobre {t}?', en: 'What do you know about {t}?' },
}

/** General questions per area — they derive from no memory at all. */
const AREA_QUESTIONS: Record<string, string> = {
  database: 'Qual a diferença entre SQL e NoSQL?',
  infrastructure: 'O que é infraestrutura como código?',
  security: 'O que é autenticação em dois fatores?',
  design: 'O que é hierarquia visual?',
  performance: 'O que é complexidade O(n)?',
  testing: 'O que é um teste de integração?',
  dependencies: 'O que é injeção de dependência?',
  architecture: 'O que é arquitetura hexagonal?',
  development: 'O que é integração contínua?',
  standards: 'O que é versionamento semântico?',
}

const OFF_TOPIC = ['Qual é a capital da Islândia?', 'Quanto é 128 dividido por 4?']

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** First usable tag; otherwise area; otherwise category. Never the text. */
function topicOf(m: Memory): string {
  const tag = (m.tags ?? []).map((t) => t.trim()).find((t) => t.length >= 3 && t.length <= 48 && !/^\d+$/.test(t))
  return tag ?? m.area ?? m.category ?? 'o projeto'
}

const PT_HINTS = new Set(['que', 'para', 'com', 'não', 'uma', 'dos', 'das', 'por', 'mais', 'como', 'mas', 'foi', 'tem', 'aqui', 'quando', 'porque', 'também', 'só', 'muito', 'bem'])

/** Minimal heuristic, only to pick cross-language queries. */
function looksPortuguese(m: Memory): boolean {
  const words = m.text.toLowerCase().normalize('NFKC').split(/[^\p{L}]+/u)
  let hits = 0
  for (const w of words) if (PT_HINTS.has(w)) hits++
  return hits >= 2 || words.length < 12
}

function fill(template: string, topic: string): string {
  return template.replace('{t}', topic)
}

/** Assembles the drafts, each memory used at most once. */
function drafts(pool: Memory[]): Array<Draft & { id: string }> {
  const byCategory = (cat: string) =>
    pool.filter((m) => m.category === cat).sort((a, b) => hash(a.id) - hash(b.id))
  const used = new Set<string>()
  const out: Draft[] = []

  const take = (cat: string, type: QueryType, n: number, lang: 'pt' | 'en' = 'pt') => {
    let added = 0
    for (const m of byCategory(cat)) {
      if (added >= n) break
      if (used.has(m.id)) continue
      used.add(m.id)
      const tpl = TEMPLATES[cat] ?? TEMPLATES.default
      out.push({ type, language: lang, text: fill(tpl[lang], topicOf(m)), expected: 'retrieve', derivedFrom: m.id })
      added++
    }
  }

  take('decision', 'decision', 3)
  take('convention', 'convention', 2)
  take('learning', 'learning', 3)
  take('structure', 'project', 2)
  take('preference', 'preference', 2)
  if (out.filter((d) => d.type === 'preference').length < 2) take('standard', 'preference', 2)

  // Cross-language: memory in Portuguese, query in English.
  const cross = pool
    .filter((m) => !used.has(m.id) && looksPortuguese(m))
    .sort((a, b) => hash(a.id) - hash(b.id))
  for (const m of cross.slice(0, 3)) {
    used.add(m.id)
    const tpl = TEMPLATES[m.category ?? ''] ?? TEMPLATES.default
    out.push({ type: 'other_language', language: 'en', text: fill(tpl.en, topicOf(m)), expected: 'retrieve', derivedFrom: m.id })
  }

  // Short and ambiguous: they depend on context that does not exist — that is the point of the test.
  const shortPool = pool.filter((m) => !used.has(m.id)).sort((a, b) => hash(a.id) - hash(b.id))
  for (const m of shortPool.slice(0, 2)) {
    used.add(m.id)
    out.push({ type: 'short', language: 'pt', text: `e o ${topicOf(m)}?`, expected: 'retrieve', derivedFrom: m.id })
  }
  for (const m of shortPool.slice(2, 4)) {
    used.add(m.id)
    out.push({ type: 'ambiguous', language: 'pt', text: `e aquele negócio de ${topicOf(m)}?`, expected: 'retrieve', derivedFrom: m.id })
  }

  // No memory: a related theme (by area present in the pool) and off-topic.
  const areaSet = new Set<string>()
  for (const m of pool) if (m.area && m.area in AREA_QUESTIONS) areaSet.add(m.area)
  const areas = [...areaSet].sort((a, b) => hash(a) - hash(b)).slice(0, 2)
  for (const area of areas) {
    out.push({ type: 'no_memory', language: 'pt', text: AREA_QUESTIONS[area], expected: 'none', derivedFrom: null })
  }
  for (const q of OFF_TOPIC) {
    out.push({ type: 'no_memory', language: 'pt', text: q, expected: 'none', derivedFrom: null })
  }

  return out.map((d, i) => ({ ...d, id: `q${String(i + 1).padStart(2, '0')}` }))
}

const GUIDE = `# How to label \`query-review.json\`

The file has one entry per query. For each one, you label **the memories that
showed up in the top 5** — not the queries.

## What to fill in

Under \`memories\`, each id carries \`text\` (the memory, just for you to read) and
two fields of yours:

- \`classification\`: \`"relevant"\`, \`"irrelevant"\`, \`"inconclusive"\` or empty.
- \`notes\`: optional, one line.

The label is **per memory**, even when it shows up in both lists
(\`lexical.top5\` and \`hybrid.top5\`). That is on purpose: it keeps the same
memory from receiving contradictory labels under each mechanism.

## Rules

- **relevant** — the memory answers the query or holds the fact the answer
  needs. Being about the same subject is not enough.
- **irrelevant** — it is about the subject but does not answer (the most common
  and the most important case to label).
- **inconclusive** — you cannot decide. It leaves the denominator and penalizes
  no one. Use it when you are genuinely unsure.
- **empty** — not evaluated yet. It also leaves the denominator.

## Queries with \`"expected": "none"\`

These are questions that **should not** retrieve a personal memory (general
knowledge or off-topic). If something shows up in the top 5 and you label it
\`relevant\`, the scorer treats it as a conflict and warns — the \`expected\` label
is probably wrong, not the search.

## \`derivedFrom\`

It is the memory that originated the synthetic query. **It is not ground
truth** — only a hypothesis. Label by what you see, including when the origin
memory does not show up in the top 5.

## Files exported before this schema was translated

A file written with the old Portuguese keys (\`esperado\`, \`memorias\`, \`texto\`,
\`classificacao\`, \`hibrido\`, \`cobertura\`, \`obs\`) still loads: the scorer
accepts both spellings, including the values \`"recuperar"\` and \`"nenhuma"\`.
New files are always written in English.

## After filling it in

\`\`\`bash
cd apps/desktop
MEMORY_REVIEW_JSON=score npx vitest run electron/lib/memory/bench/review-json.test.ts
\`\`\`

The command prints Precision@5, MRR and hit@5 per mechanism, the behavior on
the queries with no memory, and on which queries each mechanism found something
relevant. Recall@5 **cannot** be computed here: only the top 5 was judged, so
there is no telling what existed beyond it.
`

async function generate(): Promise<void> {
  if (fs.existsSync(JSON_PATH)) {
    console.log(`\n${JSON_PATH} already exists — nothing was overwritten.`)
    console.log('Move or rename the file to generate a new batch.')
    return
  }
  const pool = readMemories()
  if (pool.length < 20) {
    console.log(`\ncorpus with ${pool.length} memories — too small to generate the batch`)
    return
  }

  const embedder = await createEmbedder({
    modelPath: path.join(MODEL, 'onnx', 'model.onnx'),
    tokenizerPath: path.join(MODEL, 'tokenizer.bin'),
    dim: 256,
    maxTokens: 512,
  })

  const vectors = await embedder.embed(pool.map((m) => buildRetrievalText(m)))
  const vecMap = new Map(pool.map((m, i) => [m.id, vectors[i]] as const))
  const byId = new Map(pool.map((m) => [m.id, m] as const))
  const lexical = new Bm25Index(pool.map((m) => lexicalDocOf(m)))

  const list = drafts(pool)
  const queryVecs = await embedder.embed(list.map((d) => d.text))

  const queries = list.map((d, i) => {
    // Lexical: exactly what `memory_search` uses today.
    const tokens = tokenize(d.text)
    const lexHits = searchMemories(pool, d.text, 5)
    const lexTop = lexHits.map((m, k) => ({
      rank: k + 1,
      id: m.id,
      score: +scoreMemory(m, tokens).toFixed(3),
    }))

    // Hybrid: enriched index + calibrated fusion.
    const cands = retrieveCandidates(
      { queryVec: queryVecs[i], lexicalQuery: d.text, vectors: vecMap, lexical },
      RETRIEVAL,
    )
    const hybTop = cands.slice(0, 5).map((c, k) => ({
      rank: k + 1,
      id: c.id,
      score: +c.fused.toFixed(4),
      bm25: +c.bm25.toFixed(2),
      ...(c.cos != null ? { cos: +c.cos.toFixed(3) } : {}),
      ...(c.coverage != null ? { coverage: +c.coverage.toFixed(2) } : {}),
    }))

    const ids = new Set([...lexTop.map((h) => h.id), ...hybTop.map((h) => h.id)])
    const memories: Record<string, { text: string; classification: string; notes: string }> = {}
    for (const id of ids) {
      const m = byId.get(id)
      if (m) memories[id] = { text: m.text, classification: '', notes: '' }
    }

    return {
      id: d.id,
      origin: 'synthetic',
      type: d.type,
      language: d.language,
      context: '',
      text: d.text,
      expected: d.expected,
      derivedFrom: d.derivedFrom,
      lexical: { top5: lexTop },
      hybrid: { top5: hybTop },
      memories,
      notes: '',
    }
  })

  const payload = {
    v: 1,
    generatedAt: new Date().toISOString(),
    model: 'bekko-a8m',
    parameters: { lexWeight: RETRIEVAL.lexWeight, lexMinCoverage: RETRIEVAL.lexMinCoverage, rrfK: RETRIEVAL.rrfK },
    pool: { memories: pool.length },
    summary: {
      queries: queries.length,
      withExpectedAnswer: queries.filter((c) => c.expected === 'retrieve').length,
      noMemory: queries.filter((c) => c.expected === 'none').length,
      byType: queries.reduce<Record<string, number>>((acc, c) => {
        acc[c.type] = (acc[c.type] ?? 0) + 1
        return acc
      }, {}),
    },
    queries,
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(JSON_PATH, JSON.stringify(payload, null, 2))
  fs.writeFileSync(GUIDE_PATH, GUIDE)

  console.log(`\n=== batch generated ===`)
  console.log(`file: ${JSON_PATH}`)
  console.log(`guide: ${GUIDE_PATH}`)
  console.log(`memories in the corpus: ${pool.length}`)
  console.log(`queries: ${payload.summary.queries} (${payload.summary.withExpectedAnswer} with an expected answer, ${payload.summary.noMemory} with no memory)`)
  console.log('by type: ' + Object.entries(payload.summary.byType).map(([k, n]) => `${k} ${n}`).join(' · '))
}

function runScore(): void {
  if (!fs.existsSync(JSON_PATH)) {
    console.log(`\nno ${JSON_PATH} — run MEMORY_REVIEW_JSON=gen first`)
    return
  }
  const payload: unknown = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))
  // Accepts the legacy Portuguese keys too (`consultas`, `esperado`, `memorias`...).
  const queries = parseQueries(payload)

  const lex = scoreMechanism(queries, 'lexical')
  const hyb = scoreMechanism(queries, 'hybrid')
  const lexNo = scoreNoMemory(queries, 'lexical')
  const hybNo = scoreNoMemory(queries, 'hybrid')
  const cmp = compareMechanisms(queries)

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  const row = (label: string, s: typeof lex) =>
    `| ${label} | ${s.scored}/${s.queries} | ${pct(s.p5)} | ${s.mrr.toFixed(3)} | ${pct(s.hit5)} | ${s.relevant} | ${s.irrelevant} | ${s.inconclusive} | ${s.unjudged} |`

  if (!lex.scored && !hyb.scored) {
    console.log(`\n=== evaluation ===`)
    console.log(`${queries.length} queries, none classified yet.`)
    console.log(`fill in "classification" in ${JSON_PATH} and run again — nothing was written.`)
    return
  }

  console.log(`\n=== evaluation ===`)
  console.log(`queries: ${queries.length} · with an expected answer: ${lex.queries} · with no memory: ${lexNo.queries}`)
  console.log('')
  console.log('| mechanism | scored | P@5 | MRR | hit@5 | relev. | irrelev. | inconcl. | unjudged |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  console.log(row('lexical', lex))
  console.log(row('hybrid', hyb))
  console.log('')
  console.log(`no memory — lexical: returned a candidate on ${lexNo.returned}/${lexNo.queries}, relevant items marked ${lexNo.markedRelevant}`)
  console.log(`no memory — hybrid: returned a candidate on ${hybNo.returned}/${hybNo.queries}, relevant items marked ${hybNo.markedRelevant}`)
  if (lexNo.conflicts.length || hybNo.conflicts.length) {
    console.log(`label conflicts (marked relevant where it should not have): ${[...new Set([...lexNo.conflicts, ...hybNo.conflicts])].join(', ')}`)
  }
  console.log('')
  console.log(`both: ${cmp.both.length} · hybrid only: ${cmp.hybridOnly.length} · lexical only: ${cmp.lexicalOnly.length} · neither: ${cmp.neither.length}`)
  if (cmp.hybridOnly.length) console.log(`hybrid only: ${cmp.hybridOnly.join(', ')}`)
  if (cmp.lexicalOnly.length) console.log(`lexical only: ${cmp.lexicalOnly.join(', ')}`)
  if (cmp.neither.length) console.log(`neither: ${cmp.neither.join(', ')}`)

  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify(
      {
        evaluatedAt: new Date().toISOString(),
        lexical: lex,
        hybrid: hyb,
        comparisonNoMemory: { lexical: lexNo, hybrid: hybNo },
        comparison: cmp,
      },
      null,
      2,
    ),
  )
  console.log(`\nresult: ${RESULT_PATH}`)
}

const only = (mode: string) => (process.env.MEMORY_REVIEW_JSON === mode ? it : it.skip)

describe('JSON review', () => {
  only('gen')('generates the batch', async () => {
    await generate()
  }, 300_000)

  only('score')('computes the metrics', () => {
    runScore()
  })
})
