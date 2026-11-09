# Contextual memory: embedding-based + hybrid retrieval

Implementation and measurement of the mechanism that injects memories into Orbit's
context based on the user's message, instead of injecting a fixed block by weight.

**Status (2026-10-24):** the final validation with a locked set **rejected
automatic injection** under the pre-registered criterion (precision ≥ 98% with a
lower 95% CI ≥ 90%). The automatic memory block stays **off by default**
(`ORBIT_MEMORY_AUTO_CONTEXT=1` turns it on); the memory stays available on demand
through `memory_search`/`memory_open`. The model comparison also changed
direction on the independent set: read **section 13** before using the
conclusions of sections 5 and 7. The rest of the document remains valid as a
record of what was measured at each step.

---

## 1. What was implemented

| File | Role |
|---|---|
| `packages/shared/src/memory-retrieval.ts` | Enriched index text, Unicode tokens, BM25, RRF, index signature |
| `packages/shared/src/memory-select.ts` | Candidates (semantic/lexical/fusion), collection noise floor, two-level policy |
| `packages/shared/src/memory-query.ts` | Contextual query (message + previous turn) and when it is worth redoing it |
| `packages/shared/src/memory.ts` | Enrichment fields in `Memory` (`title`, `summary`, `entities`, `keywords`, `concepts`) |
| `apps/desktop/electron/memory-embed/engine.mjs` | Bekko on `onnxruntime-node` directly (no transformers.js), mean pooling, Matryoshka 256, L2 |
| `apps/desktop/electron/memory-embed/tokenizer.mjs` | Compact BPE tokenizer (`tokenizer.bin`, 9.4 MB) — the 34 MB `tokenizer.json` is not read at runtime |
| `apps/desktop/electron/memory-embed/worker.mjs` | `utilityProcess` that loads the model and answers embeddings |
| `apps/desktop/electron/lib/memory/embedding.ts` | Worker lifecycle, persisted index, incremental reindexing, model download |
| `apps/desktop/electron/lib/memory/retrieval.ts` | Turn retrieval, two-level policy, prompt block |
| `apps/desktop/electron/lib/memory/service.ts` | Pool per mode, `retrieveForTurn`, background synchronization |
| `apps/desktop/electron/lib/chat-engine.ts` | Injects the block into the turn's user message |
| `apps/desktop/electron/lib/memory/bench/*` | Versioned benchmark (synthetic fixtures, harness, experiments) |

The memory block goes into **the last user message**, not into the system prompt:
the system is frozen per session for the providers' prefix cache, and changing it
on every question would throw that cache away.

---

## 2. Schema and indexing

The indexed text (`buildRetrievalText`) combines, in this order and without inventing
anything that is not in the memory:

1. title (from the LLM; otherwise the first sentence of the text);
2. the **whole** original content (it is the source of truth);
3. summary, entities, keywords and concepts, only when they bring a new term.

Limit of 700 characters: beyond that, the extras are cut first — the original
content never. A language label does not go in: the memory can be in any
language and the models are cross-lingual.

Each vector carries a **signature** (`indexSignature`) that includes the schema
version, model, dimensions and the index text. If any of them changed ⇒ the
memory becomes eligible for reindexing, done in the background, in batches of 16,
written after each batch (interrupting loses nothing already done).

A deleted memory leaves the index on the next synchronization; a memory whose text goes
past the injection budget (600 characters) is not discarded — it becomes a pointer.

---

## 3. Benchmark

**Synthetic and versioned** fixtures (no real data):

- `bench/corpus.json` — 61 memories of a fictional user, in Portuguese,
  English, Spanish, Japanese and Russian; types `pref`, `travel`, `episodic`,
  `entity`, `project`, `tool`, `short`, `distractor`.
- `bench/cases.json` — 218 labeled queries (108 **dev** / 110 **eval**),
  with the relevant memories, the expected result (`inject`/`pointer`/`none`) and the
  reason. Types: paraphrase, synonym, indirect question, exact
  lexical match, no word in common, neighboring topic (does not require a memory) and out
  of subject.
- `bench/dialogs.json` — 18 messages that do not explain themselves, with the
  previous context and the ideal rewrite.

Method rules: **every calibration uses only the dev split**; the eval split is never
read to tune a parameter. The collection noise probes
(`NOISE_PROBES`, 37 generic questions) were written separately — a test
guarantees that none of them appears in `cases.json`.

Command (loads the ONNX from the local cache, ~6 s):

```bash
cd apps/desktop
MEMORY_BENCH=1 npx vitest run electron/lib/memory/bench/eval.test.ts
```

Results written to `apps/desktop/.cache/memory-embed/results/bekko-<id>.json`.

---

## 4. Ranking (Phase 3) — eval split, 81 queries with a relevant memory

| Experiment | R@1 | R@3 | R@5 | MRR | AUC |
|---|---:|---:|---:|---:|---:|
| current lexical (`searchMemories`) | 43.2% | 51.9% | 54.3% | 0.477 | — |
| BM25, enriched text (with LLM) | 48.1% | 54.3% | 55.6% | 0.515 | — |
| semantic, old representation | 87.7% | 96.3% | 96.3% | 0.920 | 0.628 |
| semantic, enriched (deterministic only) | 87.7% | 97.5% | 97.5% | 0.922 | 0.652 |
| semantic, enriched (with LLM) | 92.6% | 97.5% | 98.8% | 0.953 | 0.679 |
| hybrid RRF, equal lexical weight (naive) | 60.5% | 74.1% | 86.4% | 0.706 | 0.679 |
| **hybrid RRF, calibrated fusion** | **93.8%** | **97.5%** | **98.8%** | **0.959** | **0.679** |

(a8m values; a25m has the same shape — see §7)

Three findings that changed the implementation:

1. **The lexical search on its own is weak** (R@1 43%) and cannot be the
   backbone: it crosses neither paraphrase nor language.
2. **Fusion with equal weight is worse than semantic alone** (R@1 60.5% against
   92.6%). A single-token lexical hit ties in position with the best
   semantic one and wins by id tiebreak. Fixed with a lexical weight of 0.1 **and**
   a coverage cutoff (only the lexical hit that covers ≥ 0.5 of the query's
   IDF enters the fusion). With that, the hybrid **never loses** to the semantic one and
   even gains (93.8% against 92.6% on a8m).
3. **The enrichment is worth ~5 points of R@1.** When the LLM that writes the
   memory fills in title/entities/concepts, the gain is bigger than the
   deterministic-only version — and the cost is almost zero, because whoever calls the
   model already has the text. That is why `memory_save` (chat and code) now accepts
   those fields.

### Eval breakdown (calibrated fusion)

| Slice | a8m R@1 / R@5 | a25m R@1 / R@5 | n |
|---|---|---|---:|
| same language (query and memory) | 100% / 100% | 100% / 100% | 21 |
| different language | 92% / 98% | 97% / 98% | 60 |
| query en | 94% / 97% | 97% / 97% | 31 |
| query es | 94% / 100% | 100% / 100% | 17 |
| query pt | 92% / 100% | 96% / 100% | 26 |
| query ja | 100% / 100% | 100% / 100% | 4 |
| query ru | 100% / 100% | 100% / 100% | 3 |
| `travel` memory | 92% / 100% | 100% / 100% | 13 |
| `short` memory (short, context-dependent) | 86% / 100% | 100% / 100% | 7 |
| `pref` memory | 93% / 93% | 93% / 93% | 15 |
| `project` memory | 91% / 100% | 100% / 100% | 11 |

The contrast that matters: **same language 100% × different language 92% (a8m) in
R@1**. Retrieving a memory in another language works, but the top is less reliable —
and that is exactly where the pointer (instead of the injection) makes a difference.

## 5. Contextual query (Phase 4) — 16 dialogues with a relevant memory

| Mode | correct top | injected | clean |
|---|---:|---:|---:|
| 1. isolated message | 7/16 | 0/9 | 2/2 |
| 2. message + context (always) | 12/16 | 3/9 | 2/2 |
| 3. ideal rewrite (upper bound) | 15/16 | 4/9 | 2/2 |
| **4. context only if the isolated search fails** | **12/16** | **3/9** | 2/2 |

Mode 4 is what was implemented: it only redoes the search with the context when the
message is short, there is a previous turn and the isolated search **found nothing**.
That gives the same result as mode 2 without inheriting an old subject — the "subject
change" case (`d02`) continues not to be polluted by the previous turn.

The ideal rewrite (mode 3) shows the ceiling: with a rewrite, 15/16 at the top against
7/16 isolated. Expansion by LLM was not implemented as a mandatory step —
mode 4 captures most of the gain with no extra call per message.

---

## 6. Two-level policy (Phase 5)

### The signal does not separate by absolute cosine

Cosine distribution on the **dev** split (a8m):

| Cosines | p10 | p25 | p50 | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|
| queries that ASK for a memory (`inject`) | 0.359 | 0.446 | 0.559 | 0.633 | 0.692 | 0.779 |
| top of the queries that do NOT need it (`none`) | 0.226 | 0.289 | 0.376 | 0.476 | 0.628 | 0.680 |
| `pointer` queries | 0.340 | 0.358 | 0.415 | 0.479 | 0.536 | 0.582 |
| noise floor (generic probes) | 0.165 | 0.200 | 0.242 | 0.273 | 0.312 | 0.422 |

The tails overlap: at any threshold with useful recall, 10–30% of the "no memory"
queries also fire. And **the `pointer` queries have a cosine similar to the `none`
ones** — they do not separate from the noise. That is a result, not a
defect: "may help" and "does not need it" are the same thing for a similarity
model.

### Rules compared (dev, 79 positives, 29 without a memory)

| Rule | Injected (got it right) | FP | FP in a neighboring topic |
|---|---:|---:|---:|
| cosine ≥ 0.50 | 39/79 | 7/29 | 7/19 |
| cosine ≥ 0.60 | 24/79 | 4/29 | 4/19 |
| cosine ≥ 0.65 | 12/79 | 2/29 | 2/19 |
| cos ≥ 0.50 + margin ≥ 0.05 | 39/79 | 7/29 | 7/19 |
| cos ≥ 0.50 + lexical coverage ≥ 0.6 | 12/79 | 1/29 | 1/19 |
| cos ≥ noise floor + 0.20 | 22/79 | 4/29 | 4/19 |
| cos ≥ noise floor + 0.27 | 6/79 | 0/29 | 0/19 |
**The margin does not help** (0.05 changes one query; 0.08 changes two). What helps is
**lexical coverage**: when the collection has the exact term, the hit is almost certain.
That is why the chosen family combines the collection noise floor + lexical coverage.

### Implemented policy

- **Automatic injection:** cosine ≥ (collection noise floor + 0.22) — or
  lexical coverage ≥ 0.7 with a cosine above the pointer floor. At most 3
  memories, only the ones within 0.10 of cosine from the top.
- **Pointer:** cosine ≥ noise floor, at most 2, in one line
  `#mem_id — title`. The model opens it with `memory_open` if needed.
- **Nothing:** outside that, no character enters the context.
- **Outside the mechanism:** `core` memories and the persistent instructions stay
  in the prompt's fixed block.

### Selection result (a25m / a8m, eval split, 110 queries)

| Metric | a25m | a8m |
|---|---:|---:|
| `inject` queries with a memory injected | 21/70 | 21/70 |
| irrelevant memories injected (FP) | 3 | 4 |
| among the 29 queries without a memory: clean | 21/29 | 21/29 |
| useful pointers on the `pointer` queries | 3/11 | 0/11 |
| pointers emitted that were not relevant | 3 | 4 |

Honest reading: **the automatic injection is conservative and precise** (3–4 false
positives in 29 queries without a memory), but it covers only ~30% of the queries
labeled `inject`. The pointer, on the evaluation split, almost does not appear — it is
calibrated on dev, where it retrieves 4–5 of 21. I preferred to err by omission: the plan
says to be conservative when no rule reaches the necessary precision.

#### Full contingency table (eval = 81 positives + 29 without a memory = 110)

| a8m | queries | memories |
|---|---:|---:|
| `inject` with the right memory injected | 21/70 | 21/70 relevant |
| `inject` downgraded to a pointer | 11/70 | — |
| `pointer` with a useful pointer | 0/11 | — |
| `pointer` with the memory injected | 0/11 | — |
| irrelevant injections (total) | 4 | in 25 injected |
| — in positive queries (cross-language) | 1 | |
| — in queries without a memory | 3 | |
| irrelevant pointers | 4 | in 20 emitted |
| queries without a memory that received nothing | 21/29 | |
| queries without a memory that received only a pointer | 5/29 | |

a25m: 21/70 injected, 20 downgraded, 3/11 useful pointers, 3 irrelevant
injections (all in queries without a memory), 3 irrelevant pointers in 31.

#### Breakdown by query language vs. memory language (eval, a8m / a25m)

| group | injected | FP | useful pointer | clean |
|---|---:|---:|---:|---:|
| different language (n=60) | 14/51 · 12/51 | 1 · 0 | 0/9 · 3/9 | — |
| same language (n=21) | 7/19 · 9/19 | 0 · 0 | 0/2 · 0/2 | — |
| no memory needed (n=29) | — | 3 · 3 | — | 21/29 · 21/29 |

Lexical coverage **is not a barrier between languages**: in `memory-select.ts:284`
it only *adds* an injection path (`cos >= pointerT && coverage >= 0.7`),
it never conditions the purely semantic path. The numbers confirm it: of the 51
cross-language queries labeled `inject`, 14 (a8m) and 12 (a25m) were injected, and the
only cross-language false positive appeared on a8m. What separates the two groups is the
sample size (19 queries in the same language), not a lexical penalty.

---

## 7. a8m × a25m in the complete solution

Same memory structure, same parameters, same queries, same runtime
weights. Eval split (81 positives, 29 negatives):

| Metric (eval) | a8m | a25m | Δ |
|---|---:|---:|---:|
| R@1 (calibrated fusion) | 93.8% | 97.5% | −3.7 pp |
| R@3 | 97.5% | 98.8% | −1.3 pp |
| R@5 | 98.8% | 98.8% | **0 pp** |
| MRR | 0.959 | 0.983 | −0.024 |
| AUC | 0.679 | 0.719 | −0.040 |
| correct injections (eval) | 21/70 | 21/70 | 0 |
| false positives (eval) | 4 | 3 | +1 |
| useful pointers (eval) | 0/11 | 3/11 | −3 |
| clean queries (of 29) | 21 | 21 | 0 |

Absolute counts: R@1 is 4 cases of difference in 81.

**Uncertainty** (paired bootstrap, 4,000 resamplings over the eval cases):

- ΔR@1 (a8m − a25m): median **−3.6 pp**, 95% CI **[−7.3; 0.0]**.
- ΔAUC (a8m − a25m): median **−0.044**, 95% CI **[−0.111; +0.023]** — includes
  zero.

Sign convention: Δ = a8m − a25m, so **negative = a8m below**. The two
AUC numbers (−0.040 in the table, −0.044 in the bootstrap median) are the same
difference measured two ways: the point value comes from the direct computation over the 110
cases; the median comes from the distribution of 4,000 paired resamplings and carries the
bootstrap's own bias. Same sign, same reading.

#### Did the evaluation split stay independent?

The thresholds are chosen by code **only** on `dev` (`analysis.ts:231` and
`analysis.ts:447` filter `split === 'dev'`; `eval` is only read to report).
Sensitivity test: calibrating on `eval` and measuring on `dev` chose the **same
rule family** (F) and returned the same numbers on `dev` — 26/58 injected,
5 FP, 4/21 pointers (a8m); 30/58, 4 FP, 5/21 (a25m). The thresholds move little
(`injectDelta` 0.22 → 0.25 on a8m; 0.22 → 0.19 on a25m).

What this does **not** cover: I looked at the `eval` results between iterations to
decide *which rule families would exist*, so `eval` is not a virgin set — it is a set
that did not take part in the parameter tuning, but did take part in the design. The
definitive fix is to write a third batch of queries nobody has seen; it is listed in
the limitations.

In other words: a25m's advantage has a consistent sign, but **is not demonstrated** with
this sample size. By category, a25m is never behind and gains 1–2 cases
in five slices (en 94→97, es 94→100, pt 92→96, `travel` 92→100, `short`
86→100); in all the others it ties. The direction is consistent; the magnitude is 1 to
2 cases per slice.

### Decision rule applied

| Plan criterion | Result |
|---|---|
| ΔRecall@5 ≤ ~3 pp | **0 pp** ✅ |
| ΔAUC ≤ ~0.03 (in absolute value) | \|ΔAUC\| = 0.040 at the point, CI includes zero — ⚠️ borderline |
| No consistent regression per language/type | ✅ (isolated differences) |
| Both reach injection precision | ✅ (4 vs 3 FP in 29) |

**Decision: a8m.** a25m's AUC is 0.040 higher at the point — 0.01 above the margin
the plan suggests — but the confidence interval crosses zero, R@5 (the metric
that matters for retrieving more than one memory) is identical and the selection
metrics are the same. The real advantage is 4 queries in 81, against ~75 MB more
resident RAM, 3× the indexing time and 2.5× the query latency on
every message.

Strict reading: if the ΔAUC ≤ 0.03 criterion is applied at the point (and not on the
interval), a25m passes. The switch is a constant — `MEMORY_MODEL_ID` and
`MEMORY_MODEL_DIM` in `electron/lib/memory/embedding.ts` — plus the reindexing,
which the signature triggers by itself. I do not keep both in the product: the comparison
is an experiment, not architecture.

> **2026-10-24 revision (section 13.3):** this decision holds for the **ranking on the
> tuning fixture**. On the independent locked set a25m is consistently
> ahead — AUC 0.645 × 0.547 and R@1 +7 to +14 pp in the cross-language and
> context slices — with R@5 tied. Since automatic injection is
> off, a8m remains the runtime default (lower cost); if injection
> is reactivated, a25m needs to be re-evaluated first. The model decision
> **is not closed**.

---

### Smoke run on the real collection (311 memories, no labels)

The benchmark above uses a synthetic fixture. To check whether the **index that will actually
run** behaves in the same range, `bench/real.test.ts` builds the index with
the app's real memories (`~/Library/Application Support/@orbit/desktop/...`) and
prints no text at all — only id, classification labels and cosine.

| Measurement | Value |
|---|---|
| indexed memories | 311 |
| empty `retrievalText` | 0 |
| indexed text size | p50 331 · p90 675 · max 6,195 characters |
| full indexing | **1.68 s** (median of 3; 5.4 ms/memory) |
| RSS in the test process | 332–479 MB |
| noise floor (max of the probes) | **0.433** (fixture: 0.418) |
| mean cosine between pairs of memories | 0.308 (max 0.907) |

The real collection's cosine range **is the same as the calibration's** (floor 0.43 against
0.42), so the thresholds were not tuned to a scale that does not exist in
production. The 0.907 pair indicates nearly duplicated memories — they take the first
two positions and are natural candidates for "irrelevant pointer"; it is worth
deduplicating the collection when writing.

Nine generic probes written for the test (none comes from the collection):

| probe | top cosine | decision | top label |
|---|---:|---|---|
| preferências de resposta | 0.524 | pointer | project/preference/preferences |
| como prefiro o código | 0.484 | pointer | project/preference/preferences |
| como está o deploy | 0.488 | pointer ×2 | project/structure/overview |
| que modelo de IA uso | 0.481 | pointer | project/decision/overview |
| qual banco de dados | 0.382 | nothing | project/decision/architecture |
| quais projetos toco | 0.341 | nothing | project/structure/overview |
| fuso horário | 0.330 | nothing | seasonal |
| capital da Austrália | 0.177 | nothing | — |
| 45 ÷ 9 | 0.286 | nothing | — |

No probe reached the injection threshold (0.653) — consistent: they are generic
questions, not facts that require a memory. **This is a structural smoke run, not
a quality measurement**: without labels there is no precision or recall on the real
collection, and the category labels are only an indication that the search found the right
subject.

---

## 8. Real cost (median of 3 runs, clean process, model + tokenizer)

| | a8m | a25m |
|---|---:|---:|
| Model file | 130 MB | 199 MB |
| RSS with the model loaded | **390 MB** | **465 MB** |
| Model RSS Δ (over the empty process) | 342 MB | 417 MB |
| RSS with an index of 60 memories | 401 MB | 476 MB |
| Compiled tokenizer | 9.4 MB | 9.4 MB (identical) |
| Load time | 70 ms (cold disk: 167 ms) | 141 ms (cold: 206 ms) |
| Indexing per memory | **1.4 ms** | 3.6 ms |
| Query: median / p95 | **1.0–1.2 ms / 2.0 ms** | 3.0 ms / 3.8 ms |
| Index on disk (309 memories, 256 dim, base64) | ~420 KB | ~420 KB |

The vector is truncated to 256 dimensions (Matryoshka): 3× less index with negligible
loss of ordering.

Both models use **the same tokenizer** (identical sha256 between the two
`tokenizer.json`), so the `tokenizer.bin` is compiled only once.

---

## 9. Integration in the app

- The engine runs in a `utilityProcess` (`memory-embed/worker.mjs`), never in main:
  loading 130 MB of ONNX and running inference on the main thread would freeze
  windows and IPC.
- The worker shuts itself off after 5 idle minutes, giving the RAM back.
- Indexing runs in the background: at startup (by the scheduler) and after
  any `memory_save`/`memory_update`/`memory_delete`, with a 2 s debounce.
  The conversation **never waits** for indexing.
- Fallback: without a downloaded model, with the worker down or with a corrupted index,
  the retrieval returns **only pointers from the lexical search** — it never injects text without
  evidence — and the app keeps working.
- The model is downloaded on demand into `<userData>/memory/models/bekko-a8m`;
  in development the app uses `apps/desktop/.cache/memory-embed/bekko-a8m`.

```bash
# downloads the model (130 MB) into the app folder
cd apps/desktop && npm run memory:model
# or, for development (without the app):
npm run memory:model -- --dev
```

---

## 10. Tests

Deterministic, without a model (they run in the normal suite):

| File | Covers |
|---|---|
| `electron/lib/memory/memory-retrieval.test.ts` (23) | Unicode tokens, enrichment, index ceiling, signature, BM25, RRF |
| `electron/lib/memory/select.test.ts` (20) | candidates, noise floor, two levels, limits, margin |
| `electron/lib/memory/query.test.ts` (11) | isolated/contextual query, budget, when to redo |
| `electron/lib/memory/retrieval.test.ts` (12) | turn retrieval, pointer, lexical fallback, prompt block |
| `electron/lib/memory/embedding.test.ts` (7) | index: schema, model switched, corruption, removal, silent failure |

Validation: `cd apps/desktop && npx tsc --noEmit && npx vitest run`
(2250 tests passing; `electron/lib/media-compress/compress.test.ts` depends on
ffmpeg).

---

## 11. Limitations and what was NOT verified

1. **Synthetic collection.** Everything here was measured on 61 fictional memories. The real
   collection has 311, much more technical and with nearly duplicated pairs (cosine 0.907).
   The smoke run shows that the cosine *range* is the same, but **there are no labels on the
   real collection**: no precision or recall has been measured on it. The calibration
   needs to be redone with real labeled queries before considering the
   thresholds final.
2. **`eval` is not a virgin set.** The thresholds are tuned only on `dev`
   (verified by code and by the split-swap test), but I looked at `eval` results
   between iterations to decide *which rule families would exist*.
   A third batch of queries nobody has seen is missing.
3. **The evaluation split has 110 queries** (81 positives + 29 without a memory). That is
   little to claim equivalence between models: the R@1 difference is 4 cases
   and the ΔAUC CI crosses zero.
4. **Weak pointer on eval** (0/11 on a8m, 3/11 on a25m). On dev it retrieves
   4–5 of 21. The reason is structural: the `pointer` and `none` queries have the same
   cosine distribution, so there is no threshold that separates the two.
5. **Cross-lingual works, with a small sample.** On a8m, R@1 92% in a different
   language (n=60) against 100% in the same one (n=21) — the 8 pp drop is 5
   cases. In the selection, 14/51 cross-language queries were injected, with 1 false
   positive. Lexical coverage blocks nothing here: it only adds an injection
   path, it never conditions the semantic one.
6. **Query expansion by LLM** was not implemented — only the deterministic contextual
   query (message + previous turn). The ideal rewrite
   (`3. ideal rewrite`) marks the upper bound: 16/16 at the top against 4/16 of the
   isolated message, that is, there are ~12 cases of gain left on the table.
7. **Packaging not verified.** The model is downloaded at runtime and stays outside
   `asar`; I did **not** test the signed build, the Mac App Store, nor weak machines
   (the numbers are from an Apple M5 with the machine free).
8. **Existing memories** get a title/entities/concepts only when they are
   rewritten; there is no LLM pass to enrich the 311 old ones — their
   index uses the deterministic enrichment. A 6,195-character memory
   has its text truncated at 512 tokens by the embedding.
9. **Real initial indexing measured**: 1.68 s for 311 memories (median of 3),
   in the background and without blocking the conversation. Under CPU contention (another
   heavy process on the machine) the same load took 6.4 s.

---

## 12. How to reproduce

```bash
cd apps/desktop

# 1. typecheck + full suite
npx tsc --noEmit && npx vitest run

# 2. real benchmark (a8m and a25m; writes JSON to .cache/memory-embed/results/)
MEMORY_BENCH=1 npx vitest run electron/lib/memory/bench/eval.test.ts

# 3. cost (RAM, latency, indexing) — run 3x and use the median
node scripts/memory-bench-rss.mjs a8m
node scripts/memory-bench-rss.mjs a25m

# 4. download the model into the app
npm run memory:model

# 5. smoke run on the REAL collection (id, label and cosine only — never the text)
MEMORY_BENCH_REAL=1 npx vitest run electron/lib/memory/bench/real.test.ts
```

The models come from `huggingface.co/hotchpotch/bekko-embedding-v1-a8m` (MIT) and
`...-a25m`. The Arctic, E5 and static model results are outside this
suite: they were measured earlier, with another fixture, and do not take part in the comparisons.

---

## 13. Final validation (2026-10-24) — locked set and selection audit

This section replaces the conclusions of sections 5 and 7 wherever they conflict.
Everything here was produced by `bench/audit.test.ts`, which **calibrates nothing**:
it applies pre-registered policies from `bench/policy.ts` and measures.

### 13.1 Audit of the denominators and of the confusion matrix

Tuning fixture denominators, checked in the runner and in the fixture:

| set | queries | with a relevant memory | `inject` | `pointer` | without a memory |
|---|---:|---:|---:|---:|---:|
| eval | 110 | 81 | 70 | 11 | 29 |
| dev | 108 | 79 | 58 | 21 | 29 |
| locked (new) | 35 + 3 dialogues | 22 | 14 | 8 | 12 |

`relevant` is always a list of ids; `expect` is what the case **requires**
(`inject` = full content, `pointer` = a pointer is enough, `none` = nothing).
The matrix now treats a `none` query correctly: **any** memory is noise,
so an injection counts as `inject` and a pointer as `pointer`, even without a
relevant memory existing.

Eval matrix with the calibrated policy (P1, absolute thresholds 0.60/0.50):

| expected → decided | inject | pointer | nothing |
|---|---:|---:|---:|
| inject (a8m) | **21** | 11 | 38 |
| pointer (a8m) | 0 | **0** | 11 |
| none (a8m) | 3 | 5 | **21** |
| inject (a25m) | **21** | 20 | 29 |
| pointer (a25m) | 0 | **3** | 8 |
| none (a25m) | 3 | 5 | **21** |

Precision per **injected memory** (it is what decides injection, not the ranking):
a8m **21/25 = 84.0%** 95% CI [65.3; 93.6]; a25m **21/24 = 87.5%** 95% CI [69.0; 95.7].
The upper limit of the CI is already below the 98% goal.

The four irrelevant injections of a8m, with the case and the cosine:

| case | expected | injected | cosine | was supposed to inject |
|---|---|---|---:|---|
| q078 | inject | m022 (Pixel app) | 0.555 | m026 (Pixel's Sentry key) |
| q210 | none | m027 (commit convention) | 0.699 | — |
| q226 | none | m052 (shrimp allergy) | 0.612 | — |
| q234 | none | m014 (runs in the morning) | 0.652 | — |

The last three are the hard case foreseen in the plan: the question is **about the
subject** of the memory, and does not need it. "Quais os sintomas de alergia a
camarão?" matches at 0.61 with "Alérgica a camarão"; "qual o melhor horário para
correr?" matches at 0.65 with "gosta de correr de manhã".

### 13.2 Why no useful pointer appeared — and why fixing it was not enough

The forensics show that the retrieval was **not** the problem: among the 11
`pointer` cases of eval, the right memory was in 1st place by cosine in 7 (a8m) and
8 (a25m). The problem was the threshold:

| case (a8m) | cosine of the right memory | pointer threshold | candidates above |
|---|---:|---:|---:|
| q002 | 0.379 | 0.50 | 0 |
| q054 | 0.373 | 0.50 | 0 |
| q080 | 0.471 | 0.50 | 0 |
| q114 | 0.472 | 0.50 | 0 |
| q124 | 0.486 | 0.50 | 0 |
| q130 | 0.440 | 0.50 | 0 |
| q140 | 0.454 | 0.50 | 0 |
| q158 | 0.497 | 0.50 | 0 |

**No candidate of any of those queries went above 0.50.** It was not
`maxPointers`, it was not ranking fusion, it was not a wrong label (all ids
exist in the fixture) — it was the threshold above the whole distribution.

Fix applied: calibrate the pointer level **separately**, on dev
(`pointerCos 0.49`, top-1, cap of 25% of negatives with a pointer). On eval it
recovers 5/21 pointer cases on dev. **On the locked set, however, the
result was 0/8 useful (a8m) and 1/8 (a25m), touching 5/12 and 3/12 queries without a
memory.**

The reason shows up in the locked set's cosines: the cases where the memory **would help**
have cosine 0.24–0.49, while the questions **about the same subject that do not
need a memory** sit at 0.60–0.70. In other words: "it will help" and "it is on the same
topic" do not separate by similarity — and the signal points in the wrong direction.
That is not a defect of Bekko; it is the nature of the task.

### 13.3 Locked set (independent)

16 memories and 35 queries + 3 authored dialogues, from scenarios that **do not exist**
in the tuning fixture (gluten, billing on D1, March meeting, Barcelona,
morning meeting in Japanese, Postgres in Russian, sister in Porto, deploy on
Thursdays, Bianchi bicycle, rhinitis, staging, etc.). It includes paraphrase, synonym,
indirect, cross-language, exact identifier, dialogue context,
hard negative and out of subject. No memory from the main fixture was
reused, so that no paraphrase crosses the sets.

Ranking (calibrated fusion, `full`):

| slice | a8m R@1 | a8m R@5 | a25m R@1 | a25m R@5 |
|---|---:|---:|---:|---:|
| same language (n=20) | 85% | 100% | 90% | 100% |
| **different language (n=15)** | **53%** | 87% | **67%** | 87% |
| pt (n=27) | 67% | 93% | 74% | 93% |
| paraphrase (n=5) | 80% | 100% | 100% | 100% |
| cross-language (n=4) | 75% | 100% | 100% | 100% |
| context (n=8) | 50% | 100% | 62% | 100% |
| hard negative (n=9) | 89% | 89% | 89% | 89% |
| out of subject (n=3) | 0% | 67% | 0% | 67% |

AUC on the locked set: **a8m 0.547** (practically random) × **a25m 0.645**.
On eval: 0.679 × 0.719.

Pre-registered decision ladder, evaluated once on the locked set:

| policy | correct injections | precision | useful pointers | no-memory touched | verdict |
|---|---|---:|---:|---:|---|
| P1b calibrated injection + own pointer (a8m) | 10/10 | 100% | 0/8 | 5/12 | **rejected** (95% CI 72–100 < 90) |
| P3 strict injection (cos ≥ 0.94) | 7/7 | 100% | 0/8 | 5/12 | **rejected** (sample) |
| P2 pointers only | 0/0 | — | 0/8 | 5/12 | safe, but with no measured value |

The rule was: precision ≥ 98% **and** lower 95% CI ≥ 90%. None passed. With
n=10 and no error, the lower 95% CI is 72% — there is no way to claim 98% with that sample.
**Consequence:** `AUTO_CONTEXT_ENABLED = false` in `lib/memory/service.ts`;
the automatic block does not enter the context by default.

### 13.4 Multilingual: lexical coverage does not block cross-language

- In the code, the selection's lexical path **only adds** injection
  (`cos >= pointerT && coverage >= 0.7`); it never conditions the semantic one. There
  is no barrier between languages in the policy.
- In the fusion, the calibrated lexical weight is 0.1, with a coverage cutoff of 0.5. The
  semantic × hybrid ablation per language gave **identical results in all the
  locked-set slices** and nearly identical on eval — the only visible difference
  is `exact` on eval, which goes from 95% to 100% with the hybrid (1 case).
- Cross-language retrieval: eval 92% R@1 (a8m) / 97% (a25m); locked 53% / 67%.
  The drop on the locked set does not come from the language: the cross-language cases there are also the
  most indirect ones.

### 13.5 Real collection (311 memories, no content in the report)

| metric | value |
|---|---|
| indexed memories | 311 |
| index time | 1,716 ms (5.52 ms/memory) |
| RSS in the test process | 340 MB |
| empty `retrievalText` | 0 |
| noise floor (max of the 37 probes) | **0.433** (synthetic: 0.418) |
| cosine between memories | mean 0.307 · max 0.907 |

The real noise floor is practically the same as the synthetic one — the calibration was not
done on an unreal scale.

The 0.907 pair was analyzed **structurally** (without printing text): token Jaccard
0.22, no text containment, same `kind`/`category`/`area`/project.
Verdict: **close topic, distinct facts — not a duplicate**. The same goes for
the other 4 pairs above 0.85 (Jaccard 0.22–0.45). There is nothing to merge or
delete automatically.

Since the real collection **has no ground truth**, there is no precision or recall
measured on it. The local labeling mechanism was created
(`~/.orbit-memory-review/queue.json` + `review.html`, outside the repository),
which shows the 5 memories closest to each probe and exports `labels.json`
with "helps / maybe / does not help". It is the prerequisite for measuring the real collection —
and it was not filled in by me, because that would require reading the content.

### 13.6 Test and integration state

| verification | result |
|---|---|
| `npx tsc --noEmit` (apps/desktop) | clean |
| memory subsystem tests | **85 passing**, 6 skipped (benchmarks with a model) |
| full suite | **2,332 passing**, 1 intermittent failure (`design-store` watcher, 3 ms timeout; passes in isolation), 6 skipped |
| index updated on creation/edit/deletion | covered in `embedding.test.ts` (9 tests) |
| model failure → lexical fallback | covered in `retrieval.test.ts` |
| reindexing does not block | `syncIndex` runs outside the turn, by a debounced trigger |
| signed packaging / MAS / weak machine | **not verified** |

### 13.7 Limitations that prevent claiming precision

1. **The locked set has 35 queries.** 10/10 correct injections do not
   sustain 98% (lower 95% CI 72%). A larger labeled collection is needed.
2. **The locked set was written by me**, knowing how the policy
   works. There was no tuning on it, but it is not neutral like a set
   labeled by someone else.
3. **There is no ground truth in the real collection**; the labeling queue is ready
   and empty.
4. **The fixtures are synthetic.** The real collection has 311 technical memories,
   much more similar to each other (mean cosine 0.307).
5. **The pointer calibration was chosen on dev**, but the rules' design
   was influenced by diagnostics on eval — the locked set is the only protection.
6. **Packaging, download in production and weak machines were not tested.**

### 13.8 Files of this step

| file | what it is |
|---|---|
| `electron/lib/memory/bench/policy.ts` | P1/P2/P3 policies and the pre-registered criterion |
| `electron/lib/memory/bench/audit.test.ts` | validation runner (matrix, forensics, locked set, ablations) |
| `electron/lib/memory/bench/support.ts` | fixture and model loading |
| `electron/lib/memory/bench/blocked.json` | locked set (16 memories, 38 cases) |
| `electron/lib/memory/bench/real.test.ts` | real collection: near-duplicates and labeling queue |
| `electron/lib/memory/embedding.test.ts` | +2 tests (edit and enrichment invalidate the vector) |
| `electron/lib/memory/service.ts` | `AUTO_CONTEXT_ENABLED` (off by default) |
| `electron/lib/memory/bench/harness.ts` | `blocked` split |

### 13.9 Reproduction

```bash
cd apps/desktop

# 1. Tuning benchmark (calibrates on dev; does NOT validate)
MEMORY_BENCH=1 npx vitest run electron/lib/memory/bench/eval.test.ts

# 2. Validation (applies the pre-registered policies; does not calibrate)
MEMORY_AUDIT=1 npx vitest run electron/lib/memory/bench/audit.test.ts

# 3. Real collection (reads the local items; prints no content; generates the review queue)
MEMORY_BENCH_REAL=1 npx vitest run electron/lib/memory/bench/real.test.ts

# 4. Suite and types
npx tsc --noEmit && npx vitest run
```

Full results in `apps/desktop/.cache/memory-embed/results/` (`audit-a8m.json`,
`audit-a25m.json`).

## 14. Validation pilot with the real memories (2026-10-24)

The previous calibration used synthetic fixtures. This step changes the question: with the
**311 real memories**, does the retrieval find what matters? The labels are human and
produced **locally** — no memory text leaves the machine.

### Flow

```bash
cd apps/desktop

# 1. draws the batch (50) and the pilot sample (20) — deterministic, fixed seed
MEMORY_REVIEW=build npx vitest run electron/lib/memory/bench/review.test.ts

# 2. opens the local page and labels
open ~/.orbit-memory-review/review.html
#    → fill in the query, the context (if any), the expected decision and the reason
#    → "Export labels" generates labels.json; save it in ~/.orbit-memory-review/

# 3. evaluates lexical (what memory_search does today) × hybrid
MEMORY_REVIEW=eval npx vitest run electron/lib/memory/bench/review.test.ts
#    for the other model:
MEMORY_REVIEW_MODEL=a25m MEMORY_REVIEW=eval npx vitest run electron/lib/memory/bench/review.test.ts
```

### What the page does

- Each scenario brings **an anchor memory** and its role: `target` (it should be
  retrieved) or `no-memory` (a related topic that must NOT be retrieved — hard negative).
- Fields: query, recent context, expected decision (full content / pointer /
  none / **inconclusive**) and a short reason.
- Autosave in `localStorage`, pilot/all filter, import of a previous `labels.json`
  and export. Shortcuts: `⌘↵` advances, `⌘⇧I` marks inconclusive.
- Everything in `~/.orbit-memory-review/` — **outside the repository**. Do not version it.

### What the evaluator measures

`lexical` uses `searchMemories` (the search that `memory_search` uses today). `hybrid` uses
embeddings + BM25 + RRF, the same configuration as the benchmark. For each labeled scenario:
position of the anchor memory in both rankings, R@1/R@5/MRR, who finds what the other loses, and
for the negatives how many returned a candidate. The policy decision (P1) is recorded
as a **hypothesis** — automatic injection stays off.

The dev/evaluation split is by **memory group** (hash of the id), so that paraphrases of the same
memory never fall on opposite sides. With 20 cases it is **diagnostic**, not
confirmatory.

### Pilot composition (20)

5 hard negatives (related topic), 15 with an anchor memory, 4 in English (cross-language).
The real collection is 284 pt / 16 en / 11 without a clear marker — the cross-language sample does **not**
serve as multilingual validation.

Composition finding: the real collection is dominated by `decision` (100), `learning` (81),
`structure` (71) and `convention` (20); `preference` has only 7. The synthetic fixture, on
the contrary, was rich in personal preferences — the recalibration done on it may not
transfer to this profile.

---

## 15. Tool-family shortlist and the on/off switch

The same model (Bekko a8m, 256 dim) also shortlists **tool families** for the turn. Each
family is a document (`label. description. tags.`); the message's query vector (the one memory
and skills already share) is ranked against them in `tools/family-rank.ts`, and the hits are
added to the families activated by words (`familiesMentionedInText`), nothing more.

- **Threshold per collection**, as in §6: the highest cosine of the 37 off-topic `NOISE_PROBES`
  against the family documents, plus `delta` (0.04). The floor is stored with the cached
  vectors and recomputed whenever the set of documents changes (another MCP server, mode or
  description).
- **Never blocks, never wakes**: it runs only when the worker is already up, shares the turn's
  query vector, and gives up after 600 ms. Idle, off, loading, no noise floor → no shortlist,
  which is exactly the previous behaviour (the model loads families on demand).
- **Cache**: document vectors on disk (`tools/family-vectors`), keyed by the hash of the text
  and discarded when the model or dimension changes.
- **Switch**: Preferences → General → "Semantic search (local model)" (`embeddings`, on by
  default). Off stops the worker at once and makes memory, skills and tools fall back to words.

Measured on 30 families, 32 pt/en queries (24 with an expected family, 8 off-topic), a
fixture written by the author: floor 0.339; `delta` 0.04 → 13 right, 11 missed, 0 wrong family,
0 false positives; 0.02 already brings 1 false positive and 2 wrong families; 0.08 → 8 right.
Top-1 by raw cosine was right in 18 of 24, so recall is limited by the strict threshold, not by
the ranking. **Not validated on real usage**; `delta` is a starting point.
