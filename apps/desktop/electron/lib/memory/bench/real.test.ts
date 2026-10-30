/**
 * Smoke test on the REAL POOL (Phase 7): builds the complete index with the memories
 * the app actually uses and answers three questions the synthetic fixture does not
 * answer — does the real pool fit the budget? does the cosine range match the
 * calibrated one? is the real noise floor the same?
 *
 *   MEMORY_BENCH_REAL=1 npx vitest run electron/lib/memory/bench/real.test.ts
 *
 * PRIVACY: this test NEVER prints `text`, `title` or `summary`. Only id,
 * classification labels (kind/category/area), timings and cosines —
 * enough to judge the calibration without bringing personal content into the chat.
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
import type { Memory } from '@shared/memory'

const ITEMS = path.join(os.homedir(), 'Library/Application Support/@orbit/desktop/orbit-data/storage/memory/items')
const MODEL = path.resolve(__dirname, '../../../../.cache/memory-embed/bekko-a8m')

/** Production parameters, as the benchmark chose them on the dev split (a8m). */
const RETRIEVAL = { ...DEFAULT_RETRIEVAL, semWeight: 1, lexWeight: 0.1, lexMinCoverage: 0.5 }
const PRODUCTION: SelectionParams = {
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

/** Generic probes written for this test — they do not come from the user's pool. */
const PROBES = [
  'qual banco de dados o projeto usa?',
  'como eu prefiro que o código seja escrito?',
  'quais projetos eu estou tocando agora?',
  'qual é o meu fuso horário?',
  'como está o deploy do aplicativo?',
  'que modelo de IA eu costumo usar?',
  'quais são minhas preferências de resposta?',
  'qual a capital da Austrália?',
  'quanto é 45 dividido por 9?',
]

function cos(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const gated = process.env.MEMORY_BENCH_REAL ? describe : describe.skip

gated('real corpus (smoke)', () => {
  it('builds the index and measures the cosine range', async () => {
    const files = fs.readdirSync(ITEMS).filter((f) => f.endsWith('.json'))
    const memories: Memory[] = []
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(ITEMS, f), 'utf8'))
      for (const m of Array.isArray(raw) ? raw : [raw]) if (m?.text) memories.push(m as Memory)
    }

    const embedder = await createEmbedder({
      modelPath: path.join(MODEL, 'onnx', 'model.onnx'),
      tokenizerPath: path.join(MODEL, 'tokenizer.bin'),
      dim: 256,
      maxTokens: 512,
    })

    const texts = memories.map((m) => buildRetrievalText(m))
    const empty = texts.filter((t) => !t.trim()).length
    const lens = texts.map((t) => t.length).sort((a, b) => a - b)
    const t0 = performance.now()
    const vectors = await embedder.embed(texts)
    const indexMs = performance.now() - t0
    const rss = process.memoryUsage().rss

    const byId = new Map(memories.map((m, i) => [m.id, { m, v: vectors[i] }]))
    const vecMap = new Map([...byId].map(([id, x]) => [id, x.v]))
    const lexical = new Bm25Index(memories.map((m) => lexicalDocOf(m)))

    // Noise floor of the real pool, exactly as production computes it.
    const probeVecs = await embedder.embed(NOISE_PROBES)
    const noise = noiseFloorOf(probeVecs, vecMap)
    const floor = quantile(noise.tops, PRODUCTION.noiseQuantile)

    const queryVecs = await embedder.embed(PROBES)
    const probeRows = PROBES.map((q, i) => {
      const qv = queryVecs[i]
      const cands = retrieveCandidates({ queryVec: qv, lexicalQuery: q, vectors: vecMap, lexical }, RETRIEVAL)
      const sel = selectForContext(cands, noise, PRODUCTION)
      const top = cands.find((c) => c.cos != null)
      const hit = top ? memories.find((m) => m.id === top.id) : undefined
      return {
        q,
        topCos: +(top?.cos ?? NaN).toFixed(3),
        secondCos: +(cands.filter((c) => c.cos != null)[1]?.cos ?? NaN).toFixed(3),
        tier: sel.inject.length ? `inject ${sel.inject.length}` : sel.pointers.length ? `pointer ${sel.pointers.length}` : 'none',
        topLabels: hit ? `${hit.kind}/${hit.category ?? '-'}/${hit.area ?? '-'}` : '-',
      }
    })

    // Cosine of the query against each memory's own retrievalText:
    // measures whether the pool is internally redundant (everything close to everything).
    let selfSum = 0
    let pairs = 0
    let maxPair = 0
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const s = cos(vectors[i], vectors[j])
        selfSum += s
        pairs++
        if (s > maxPair) maxPair = s
      }
    }

    // --- Near-identical pairs: are they a duplicate, a complementary variation or just a nearby theme?
    // STRUCTURAL comparison (no text printed): token Jaccard, containment,
    // equal labels and length ratio.
    const toks = (t: string) =>
      new Set(
        t
          .toLowerCase()
          .normalize('NFKC')
          .split(/[^\p{L}\p{N}]+/u)
          .filter((x) => x.length > 2),
      )
    const jaccard = (a: Set<string>, b: Set<string>) => {
      let inter = 0
      for (const x of a) if (b.has(x)) inter++
      const uni = a.size + b.size - inter
      return uni ? inter / uni : 0
    }
    const nearDupRows: Array<Record<string, unknown>> = []
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const c = cos(vectors[i], vectors[j])
        if (c < 0.85) continue
        const A = memories[i]
        const B = memories[j]
        const ta = toks(A.text)
        const tb = toks(B.text)
        nearDupRows.push({
          a: A.id,
          b: B.id,
          cos: +c.toFixed(3),
          jaccard: +jaccard(ta, tb).toFixed(3),
          containment: A.text.includes(B.text) || B.text.includes(A.text),
          sameKind: A.kind === B.kind,
          sameCategory: (A.category ?? null) === (B.category ?? null),
          sameArea: (A.area ?? null) === (B.area ?? null),
          sameProject: (A.projectId ?? null) === (B.projectId ?? null),
          lenRatio: +(Math.min(A.text.length, B.text.length) / Math.max(A.text.length, B.text.length)).toFixed(2),
          verdict:
            jaccard(ta, tb) > 0.85 || A.text.includes(B.text) || B.text.includes(A.text)
              ? 'probable duplicate'
              : jaccard(ta, tb) > 0.5
                ? 'variation of the same fact'
                : 'close topic, distinct facts',
        })
      }
    }
    nearDupRows.sort((x, y) => (y.cos as number) - (x.cos as number))

    // --- Local review queue (human labelling) --------------------------
    // Outside the repository: ~/.orbit-memory-review/. Only the pool's owner reads it.
    const reviewDir = path.join(os.homedir(), '.orbit-memory-review')
    fs.mkdirSync(reviewDir, { recursive: true })
    const queue = PROBES.map((q, i) => {
      const qv = queryVecs[i]
      const cands = retrieveCandidates({ queryVec: qv, lexicalQuery: q, vectors: vecMap, lexical }, RETRIEVAL).slice(0, 5)
      return {
        probe: q,
        candidates: cands.map((c) => ({ id: c.id, cos: +(c.cos ?? 0).toFixed(3), text: memories.find((m) => m.id === c.id)?.text ?? '' })),
      }
    })
    fs.writeFileSync(path.join(reviewDir, 'queue.json'), JSON.stringify(queue, null, 2))
    const payload = JSON.stringify(queue).replace(/</g, '\\u003c')
    fs.writeFileSync(
      path.join(reviewDir, 'review.html'),
      `<!doctype html><meta charset="utf-8"><title>Memory review</title>
<style>body{font:14px/1.5 system-ui;max-width:900px;margin:2rem auto;padding:0 1rem;background:#111;color:#eee}
h2{font-size:15px;margin:2rem 0 .5rem;color:#f5c542}.c{border:1px solid #333;border-radius:8px;padding:.6rem .8rem;margin:.5rem 0}
label{margin-right:1rem;cursor:pointer}.id{color:#888;font-size:12px}button{margin-top:1rem;padding:.6rem 1rem;border-radius:8px;border:0;background:#f5c542;font-weight:600;cursor:pointer}</style>
<h1>Memory review</h1><p>For each probe, mark the memories that <b>would help answer</b> — not the ones that merely talk about the same subject. This becomes the ground truth of the real collection.</p>
<div id="app"></div><button id="exp">Export labels</button>
<script>const Q=${payload};
document.getElementById('app').innerHTML=Q.map((q,qi)=>'<h2>'+(qi+1)+'. '+q.probe+'</h2>'+q.candidates.map((c,ci)=>
 '<div class="c"><div>'+c.text+'</div><div class="id">'+c.id+' · cos '+c.cos+'</div>'+
 [0,1,2].map(k=>'<label><input type="radio" name="q'+qi+'c'+ci+'" value="'+['no','maybe','yes'][k]+'"> '+['does not help','maybe','helps'][k]+'</label>').join('')+'</div>').join('')).join('')
document.getElementById('exp').onclick=()=>{const out=Q.map((q,qi)=>({probe:q.probe,labels:q.candidates.map((c,ci)=>{const el=document.querySelector('input[name="q'+qi+'c'+ci+'"]:checked');return {id:c.id,label:el?el.value:'no'}})}));
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));a.download='labels.json';a.click()}</script>`,
    )

    console.log(
      JSON.stringify(
        {
          memories: memories.length,
          emptyRetrievalText: empty,
          retrievalChars: { p50: lens[Math.floor(lens.length * 0.5)], p90: lens[Math.floor(lens.length * 0.9)], max: lens[lens.length - 1] },
          indexMs: Math.round(indexMs),
          msPerMemory: +(indexMs / memories.length).toFixed(2),
          rssMB: Math.round(rss / 1e6),
          noiseFloorMax: +floor.toFixed(3),
          noiseP50: +quantile(noise.tops, 0.5).toFixed(3),
          injectT: +(floor + PRODUCTION.injectDelta).toFixed(3),
          pointerT: +(floor + PRODUCTION.pointerDelta).toFixed(3),
          pairCos: { mean: +(selfSum / pairs).toFixed(3), max: +maxPair.toFixed(3) },
          probes: probeRows,
          nearDuplicates: nearDupRows,
          reviewQueue: reviewDir,
        },
        null,
        2,
      ),
    )
  }, 300_000)
})
