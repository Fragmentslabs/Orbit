/**
 * Avaliação por JSON do acervo real — sem página, sem interface.
 *
 *   MEMORY_REVIEW_JSON=gen   npx vitest run electron/lib/memory/bench/review-json.test.ts
 *   MEMORY_REVIEW_JSON=score npx vitest run electron/lib/memory/bench/review-json.test.ts
 *
 * `gen` monta ~23 consultas a partir das memórias reais, roda a busca lexical e
 * a híbrida sobre exatamente as mesmas consultas e grava um JSON local para
 * revisão, mais um guia curto. `score` lê as classificações e compara os dois
 * mecanismos.
 *
 * PRIVACIDADE: o texto das memórias vai APENAS para o arquivo JSON local. Este
 * runner imprime contagens, ids e métricas — nunca `text`, `title` ou `summary`.
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
  scoreMechanism,
  scoreNoMemory,
  type ReviewQueryJson,
} from './review-json-metrics'

const MODEL = path.resolve(__dirname, '../../../../.cache/memory-embed/bekko-a8m')

/** Mesmos parâmetros de retrieval do benchmark (a8m, calibrado no dev). */
const RETRIEVAL = { ...DEFAULT_RETRIEVAL, semWeight: 1, lexWeight: 0.1, lexMinCoverage: 0.5 }

const JSON_PATH = path.join(OUT, 'avaliacao-consultas.json')
const GUIDE_PATH = path.join(OUT, 'COMO-ROTULAR.md')

type Tipo = 'decisao' | 'convencao' | 'aprendizado' | 'projeto' | 'preferencia' | 'curta' | 'ambigua' | 'outro_idioma' | 'sem_memoria'

interface Draft {
  tipo: Tipo
  idioma: 'pt' | 'en'
  texto: string
  esperado: 'recuperar' | 'nenhuma'
  derivadaDe: string | null
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

/** Perguntas gerais por área — não derivam de memória nenhuma. */
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

/** Primeiro tag utilizável; senão area; senão category. Nunca o texto. */
function topicOf(m: Memory): string {
  const tag = (m.tags ?? []).map((t) => t.trim()).find((t) => t.length >= 3 && t.length <= 48 && !/^\d+$/.test(t))
  return tag ?? m.area ?? m.category ?? 'o projeto'
}

const PT_HINTS = new Set(['que', 'para', 'com', 'não', 'uma', 'dos', 'das', 'por', 'mais', 'como', 'mas', 'foi', 'tem', 'aqui', 'quando', 'porque', 'também', 'só', 'muito', 'bem'])

/** Heurística mínima, só para escolher consultas cruzadas. */
function looksPortuguese(m: Memory): boolean {
  const words = m.text.toLowerCase().normalize('NFKC').split(/[^\p{L}]+/u)
  let hits = 0
  for (const w of words) if (PT_HINTS.has(w)) hits++
  return hits >= 2 || words.length < 12
}

function fill(template: string, topic: string): string {
  return template.replace('{t}', topic)
}

/** Monta os rascunhos, cada memória usada no máximo uma vez. */
function drafts(pool: Memory[]): Array<Draft & { id: string }> {
  const byCategory = (cat: string) =>
    pool.filter((m) => m.category === cat).sort((a, b) => hash(a.id) - hash(b.id))
  const used = new Set<string>()
  const out: Draft[] = []

  const take = (cat: string, tipo: Tipo, n: number, lang: 'pt' | 'en' = 'pt') => {
    let added = 0
    for (const m of byCategory(cat)) {
      if (added >= n) break
      if (used.has(m.id)) continue
      used.add(m.id)
      const tpl = TEMPLATES[cat] ?? TEMPLATES.default
      out.push({ tipo, idioma: lang, texto: fill(tpl[lang], topicOf(m)), esperado: 'recuperar', derivadaDe: m.id })
      added++
    }
  }

  take('decision', 'decisao', 3)
  take('convention', 'convencao', 2)
  take('learning', 'aprendizado', 3)
  take('structure', 'projeto', 2)
  take('preference', 'preferencia', 2)
  if (out.filter((d) => d.tipo === 'preferencia').length < 2) take('standard', 'preferencia', 2)

  // Cruzadas: memória em português, consulta em inglês.
  const cross = pool
    .filter((m) => !used.has(m.id) && looksPortuguese(m))
    .sort((a, b) => hash(a.id) - hash(b.id))
  for (const m of cross.slice(0, 3)) {
    used.add(m.id)
    const tpl = TEMPLATES[m.category ?? ''] ?? TEMPLATES.default
    out.push({ tipo: 'outro_idioma', idioma: 'en', texto: fill(tpl.en, topicOf(m)), esperado: 'recuperar', derivadaDe: m.id })
  }

  // Curtas e ambíguas: dependem de contexto que não existe — é o ponto do teste.
  const shortPool = pool.filter((m) => !used.has(m.id)).sort((a, b) => hash(a.id) - hash(b.id))
  for (const m of shortPool.slice(0, 2)) {
    used.add(m.id)
    out.push({ tipo: 'curta', idioma: 'pt', texto: `e o ${topicOf(m)}?`, esperado: 'recuperar', derivadaDe: m.id })
  }
  for (const m of shortPool.slice(2, 4)) {
    used.add(m.id)
    out.push({ tipo: 'ambigua', idioma: 'pt', texto: `e aquele negócio de ${topicOf(m)}?`, esperado: 'recuperar', derivadaDe: m.id })
  }

  // Sem memória: tema relacionado (por área presente no acervo) e fora de assunto.
  const areaSet = new Set<string>()
  for (const m of pool) if (m.area && m.area in AREA_QUESTIONS) areaSet.add(m.area)
  const areas = [...areaSet].sort((a, b) => hash(a) - hash(b)).slice(0, 2)
  for (const area of areas) {
    out.push({ tipo: 'sem_memoria', idioma: 'pt', texto: AREA_QUESTIONS[area], esperado: 'nenhuma', derivadaDe: null })
  }
  for (const q of OFF_TOPIC) {
    out.push({ tipo: 'sem_memoria', idioma: 'pt', texto: q, esperado: 'nenhuma', derivadaDe: null })
  }

  return out.map((d, i) => ({ ...d, id: `q${String(i + 1).padStart(2, '0')}` }))
}

const GUIDE = `# Como rotular \`avaliacao-consultas.json\`

O arquivo tem uma entrada por consulta. Para cada uma, você classifica **as
memórias que apareceram no top 5** — não as consultas.

## O que preencher

Em \`memorias\`, cada id traz \`texto\` (a memória, só para você ler) e dois campos
seus:

- \`classificacao\`: \`"relevant"\`, \`"irrelevant"\`, \`"inconclusive"\` ou vazio.
- \`obs\`: opcional, uma linha.

A classificação é **única por memória**, mesmo que ela apareça nas duas listas
(\`lexical.top5\` e \`hibrido.top5\`). Isso é de propósito: evita que a mesma
memória receba rótulos contraditórios em cada mecanismo.

## Regras

- **relevant** — a memória responde à consulta ou contém o fato que a resposta
  precisa. Não basta ser do mesmo assunto.
- **irrelevant** — é do assunto, mas não responde (o caso mais comum e o mais
  importante de marcar).
- **inconclusive** — você não consegue decidir. Sai do denominador, não penaliza
  ninguém. Use quando estiver em dúvida de verdade.
- **vazio** — ainda não avaliado. Também sai do denominador.

## Consultas com \`"esperado": "nenhuma"\`

São perguntas que **não devem** recuperar memória pessoal (conhecimento geral ou
fora de assunto). Se algo aparecer no top 5 e você marcar \`relevant\`, o
avaliador trata como conflito e avisa — provavelmente o rótulo de \`esperado\`
está errado, não a busca.

## \`derivadaDe\`

É a memória que originou a consulta sintética. **Não é ground truth** — é só uma
hipótese. Classifique pelo que você vê, inclusive se a memória de origem não
aparecer no top 5.

## Depois de preencher

\`\`\`bash
cd apps/desktop
MEMORY_REVIEW_JSON=score npx vitest run electron/lib/memory/bench/review-json.test.ts
\`\`\`

O comando imprime Precision@5, MRR e hit@5 por mecanismo, o comportamento nas
consultas sem memória e em quais consultas cada mecanismo achou algo relevante.
Recall@5 **não** é calculável aqui: só o top 5 foi julgado, então não se sabe o
que existia além dele.
`

async function generate(): Promise<void> {
  if (fs.existsSync(JSON_PATH)) {
    console.log(`\n${JSON_PATH} já existe — nada foi sobrescrito.`)
    console.log('Mova ou renomeie o arquivo para gerar um novo lote.')
    return
  }
  const pool = readMemories()
  if (pool.length < 20) {
    console.log(`\nacervo com ${pool.length} memórias — pequeno demais para gerar o lote`)
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
  const queryVecs = await embedder.embed(list.map((d) => d.texto))

  const consultas = list.map((d, i) => {
    // Lexical: exatamente o que `memory_search` usa hoje.
    const tokens = tokenize(d.texto)
    const lexHits = searchMemories(pool, d.texto, 5)
    const lexTop = lexHits.map((m, k) => ({
      rank: k + 1,
      id: m.id,
      score: +scoreMemory(m, tokens).toFixed(3),
    }))

    // Híbrido: índice enriquecido + fusão calibrada.
    const cands = retrieveCandidates(
      { queryVec: queryVecs[i], lexicalQuery: d.texto, vectors: vecMap, lexical },
      RETRIEVAL,
    )
    const hybTop = cands.slice(0, 5).map((c, k) => ({
      rank: k + 1,
      id: c.id,
      score: +c.fused.toFixed(4),
      bm25: +c.bm25.toFixed(2),
      ...(c.cos != null ? { cos: +c.cos.toFixed(3) } : {}),
      ...(c.coverage != null ? { cobertura: +c.coverage.toFixed(2) } : {}),
    }))

    const ids = new Set([...lexTop.map((h) => h.id), ...hybTop.map((h) => h.id)])
    const memorias: Record<string, { texto: string; classificacao: string; obs: string }> = {}
    for (const id of ids) {
      const m = byId.get(id)
      if (m) memorias[id] = { texto: m.text, classificacao: '', obs: '' }
    }

    return {
      id: d.id,
      origem: 'sintetica',
      tipo: d.tipo,
      idioma: d.idioma,
      contexto: '',
      texto: d.texto,
      esperado: d.esperado,
      derivadaDe: d.derivadaDe,
      lexical: { top5: lexTop },
      hibrido: { top5: hybTop },
      memorias,
      observacoes: '',
    }
  })

  const payload = {
    v: 1,
    geradoEm: new Date().toISOString(),
    modelo: 'bekko-a8m',
    parametros: { lexWeight: RETRIEVAL.lexWeight, lexMinCoverage: RETRIEVAL.lexMinCoverage, rrfK: RETRIEVAL.rrfK },
    acervo: { memorias: pool.length },
    resumo: {
      consultas: consultas.length,
      comRespostaEsperada: consultas.filter((c) => c.esperado === 'recuperar').length,
      semMemoria: consultas.filter((c) => c.esperado === 'nenhuma').length,
      porTipo: consultas.reduce<Record<string, number>>((acc, c) => {
        acc[c.tipo] = (acc[c.tipo] ?? 0) + 1
        return acc
      }, {}),
    },
    consultas,
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(JSON_PATH, JSON.stringify(payload, null, 2))
  fs.writeFileSync(GUIDE_PATH, GUIDE)

  console.log(`\n=== lote gerado ===`)
  console.log(`arquivo: ${JSON_PATH}`)
  console.log(`guia:    ${GUIDE_PATH}`)
  console.log(`memórias no acervo: ${pool.length}`)
  console.log(`consultas: ${payload.resumo.consultas} (${payload.resumo.comRespostaEsperada} com resposta esperada, ${payload.resumo.semMemoria} sem memória)`)
  console.log('por tipo: ' + Object.entries(payload.resumo.porTipo).map(([k, n]) => `${k} ${n}`).join(' · '))
}

function runScore(): void {
  if (!fs.existsSync(JSON_PATH)) {
    console.log(`\nsem ${JSON_PATH} — rode MEMORY_REVIEW_JSON=gen primeiro`)
    return
  }
  const payload = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) as { consultas: ReviewQueryJson[] }
  const queries = payload.consultas

  const lex = scoreMechanism(queries, 'lexical')
  const hyb = scoreMechanism(queries, 'hibrido')
  const lexNo = scoreNoMemory(queries, 'lexical')
  const hybNo = scoreNoMemory(queries, 'hibrido')
  const cmp = compareMechanisms(queries)

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  const row = (nome: string, s: typeof lex) =>
    `| ${nome} | ${s.avaliadas}/${s.consultas} | ${pct(s.p5)} | ${s.mrr.toFixed(3)} | ${pct(s.hit5)} | ${s.relevantes} | ${s.irrelevantes} | ${s.inconclusivos} | ${s.semJulgamento} |`

  if (!lex.avaliadas && !hyb.avaliadas) {
    console.log(`\n=== avaliação ===`)
    console.log(`${queries.length} consultas, nenhuma classificada ainda.`)
    console.log(`preencha "classificacao" em ${JSON_PATH} e rode de novo — nada foi gravado.`)
    return
  }

  console.log(`\n=== avaliação ===`)
  console.log(`consultas: ${queries.length} · com resposta esperada: ${lex.consultas} · sem memória: ${lexNo.consultas}`)
  console.log('')
  console.log('| mecanismo | avaliadas | P@5 | MRR | hit@5 | relev. | irrelev. | inconcl. | s/ julg. |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  console.log(row('lexical', lex))
  console.log(row('híbrido', hyb))
  console.log('')
  console.log(`sem memória — lexical: devolveu candidato em ${lexNo.retornou}/${lexNo.consultas}, relevantes marcados ${lexNo.marcouRelevante}`)
  console.log(`sem memória — híbrido: devolveu candidato em ${hybNo.retornou}/${hybNo.consultas}, relevantes marcados ${hybNo.marcouRelevante}`)
  if (lexNo.conflitos.length || hybNo.conflitos.length) {
    console.log(`conflitos de rótulo (marcou relevant onde não deveria): ${[...new Set([...lexNo.conflitos, ...hybNo.conflitos])].join(', ')}`)
  }
  console.log('')
  console.log(`ambos: ${cmp.ambos.length} · só híbrido: ${cmp.soHibrido.length} · só lexical: ${cmp.soLexical.length} · nenhum: ${cmp.nenhum.length}`)
  if (cmp.soHibrido.length) console.log(`só híbrido: ${cmp.soHibrido.join(', ')}`)
  if (cmp.soLexical.length) console.log(`só lexical: ${cmp.soLexical.join(', ')}`)
  if (cmp.nenhum.length) console.log(`nenhum: ${cmp.nenhum.join(', ')}`)

  fs.writeFileSync(
    path.join(OUT, 'avaliacao-resultado.json'),
    JSON.stringify(
      {
        avaliadoEm: new Date().toISOString(),
        lexical: lex,
        hibrido: hyb,
        semMemoria: { lexical: lexNo, hibrido: hybNo },
        comparacao: cmp,
      },
      null,
      2,
    ),
  )
  console.log(`\nresultado: ${path.join(OUT, 'avaliacao-resultado.json')}`)
}

const only = (mode: string) => (process.env.MEMORY_REVIEW_JSON === mode ? it : it.skip)

describe('avaliação por JSON', () => {
  only('gen')('gera o lote', async () => {
    await generate()
  }, 300_000)

  only('score')('calcula as métricas', () => {
    runScore()
  })
})
