import { generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai'
import { BrowserWindow } from 'electron'
import type { InitEvent, InitStatus, Memory, ProjectArea, ProjectCategory } from '../../../shared/memory'
import { PROJECT_AREAS } from '../../../shared/memory'
import { projectIdOf } from '../memory/domain'
import * as memoryService from '../memory/service'
import { resolveModel } from '../providers'
import { createGlobTool, createGrepTool, createListTool, createReadTool } from '../tools/files'
import type { ToolContext } from '../tools/context'
import { describeScan, scanProject, type ProjectScan } from './scanner'

/**
 * Pipeline do /init (orquestrado): scanner determinístico → subagents em
 * paralelo (um por área, com ferramentas read-only) exploram o código → o
 * agente principal revisa os levantamentos, corrige e divide nas memórias
 * finais por área — ligadas ao node central (overview) via relatedIds.
 * É isso que popula o grafo de memórias: root = projeto, satélites = áreas.
 */

const running = new Set<string>()
const WORKER_CONCURRENCY = 3
const WORKER_MAX_STEPS = 12
const WORKER_TIMEOUT_MS = 4 * 60 * 1000

function emit(event: InitEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('init:event', event)
  }
}

/** Área → categoria do sistema de memória (define TTL/prioridade no prompt).
 * Nenhuma usa "context" — memórias de init não devem expirar em 30d. */
const AREA_CATEGORY: Record<ProjectArea, ProjectCategory> = {
  overview: 'structure',
  business: 'decision',
  design: 'convention',
  architecture: 'structure',
  preferences: 'preference',
  infrastructure: 'structure',
  security: 'decision',
  development: 'convention',
}

/** Missão de investigação de cada subagent (a área overview é sintetizada
 * pelo revisor a partir de tudo — não tem worker próprio). */
const AREA_MISSIONS: Record<Exclude<ProjectArea, 'overview'>, string> = {
  business:
    'Regras de negócio: identifique as entidades centrais, fluxos principais e regras críticas. Procure modelos/schemas, validações, máquinas de estado e serviços de domínio. Cite arquivos.',
  design:
    'Design system e UI: componentes base (pasta de ui/components), tokens/tema, padrões visuais, convenções de estilo (tailwind/css-in-js), acessibilidade. Cite os componentes canônicos que novas telas devem reutilizar.',
  architecture:
    'Arquitetura: módulos e camadas, como se comunicam (IPC, HTTP, eventos, filas), onde ficam dados/estado, pontos de entrada. Desenhe o mapa mental do repositório com caminhos reais.',
  preferences:
    'Preferências e convenções: estilo de código observado (naming, organização de arquivos, idioma de comentários), configs de lint/format, padrões de commit/branch se visíveis.',
  infrastructure:
    'Infraestrutura: build, deploy, CI/CD, containers, variáveis de ambiente necessárias. Liste os comandos e arquivos de config relevantes.',
  security:
    'Segurança: autenticação/autorização, gestão de segredos e chaves, dados sensíveis, superfícies de risco (IPC exposto, execução de shell, inputs externos). Cite os arquivos envolvidos.',
  development:
    'Desenvolvimento local: setup, scripts (dev/build/test/lint), pré-requisitos, como rodar e testar. Liste os comandos exatos.',
}

/** Decide quais áreas investigar com base em evidências do scan. */
export function planAreas(scan: ProjectScan): Exclude<ProjectArea, 'overview'>[] {
  const areas: Exclude<ProjectArea, 'overview'>[] = ['architecture', 'business', 'development', 'preferences']
  if (scan.ui.length > 0) areas.push('design')
  if (scan.infra.length > 0 || Object.keys(scan.scripts).some((s) => /deploy|docker|release/.test(s))) {
    areas.push('infrastructure')
  }
  if (scan.security.length > 0) areas.push('security')
  return areas
}

function readOnlyTools(directory: string, abort: AbortSignal): ToolSet {
  const ctx: ToolContext = { sessionId: `init:${directory}`, directory, extraDirectories: [], abort }
  return {
    read: createReadTool(ctx),
    ls: createListTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
  }
}

interface AreaFindings {
  area: Exclude<ProjectArea, 'overview'>
  findings: string
  failed?: boolean
}

/** Subagent de uma área: explora o repositório com tools read-only. */
async function exploreArea(
  model: LanguageModel,
  scanDescription: string,
  directory: string,
  area: Exclude<ProjectArea, 'overview'>,
): Promise<AreaFindings> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS)
  try {
    const { text } = await generateText({
      model,
      system: `Você é um subagent de onboarding do Orbit investigando UMA área de um projeto. Use as ferramentas (read, ls, glob, grep) para VERIFICAR no código — não deduza só pelo scan. Seja econômico: poucos arquivos certos valem mais que varrer tudo. Responda em português, em markdown, citando caminhos de arquivos reais. Termine com uma linha "TAGS:" com 3-6 palavras-chave.`,
      prompt: `Área investigada: ${PROJECT_AREAS[area].label}
Missão: ${AREA_MISSIONS[area]}

Contexto do scan automático (ponto de partida, não conclusão):
${scanDescription}`,
      tools: readOnlyTools(directory, controller.signal),
      stopWhen: stepCountIs(WORKER_MAX_STEPS),
      abortSignal: controller.signal,
    })
    return { area, findings: text }
  } catch (err) {
    return {
      area,
      findings: `(exploração falhou: ${err instanceof Error ? err.message : String(err)})`,
      failed: true,
    }
  } finally {
    clearTimeout(timeout)
  }
}

/** Executa os subagents com limite de concorrência, emitindo progresso. */
async function exploreAll(
  model: LanguageModel,
  scanDescription: string,
  directory: string,
  areas: Exclude<ProjectArea, 'overview'>[],
): Promise<AreaFindings[]> {
  const results: AreaFindings[] = []
  let done = 0
  const queue = [...areas]
  const workers = Array.from({ length: Math.min(WORKER_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const area = queue.shift()!
      const result = await exploreArea(model, scanDescription, directory, area)
      results.push(result)
      done += 1
      emit({ directory, stage: 'exploring', progress: { done, total: areas.length, area } })
    }
  })
  await Promise.all(workers)
  return results
}

interface GeneratedArea {
  area: ProjectArea
  /** Resumo curto (2-4 frases) — vira o texto da memória (entra no prompt) */
  summary: string
  tags: string[]
  /** Documento markdown completo da área */
  document: string
}

function buildReviewerPrompt(scanDescription: string, findings: AreaFindings[]): string {
  const areaList = Object.entries(PROJECT_AREAS)
    .map(([id, meta]) => `- "${id}" (${meta.label}): ${meta.description}`)
    .join('\n')
  const reports = findings
    .map((f) => `### Levantamento — ${PROJECT_AREAS[f.area].label} (${f.area})${f.failed ? ' [FALHOU]' : ''}\n${f.findings}`)
    .join('\n\n')
  return `Você é o agente principal do onboarding do Orbit. Subagents investigaram o projeto por área; seu papel é REVISAR e MELHORAR os levantamentos (remover especulação, resolver contradições com o scan, condensar) e dividi-los em memórias finais por área.

Áreas possíveis:
${areaList}

Regras:
- Gere SEMPRE "overview" (síntese: sobre o que é o projeto, stack e tecnologias, estrutura geral) a partir do conjunto.
- Para cada levantamento aproveitável, gere a memória da área correspondente. Descarte áreas cujo levantamento falhou ou não trouxe evidência real.
- "summary": 2-4 frases objetivas — é o que entra no contexto do agente.
- "document": markdown estruturado e revisado (caminhos de arquivos, comandos, convenções) — pode reorganizar e corrigir o texto do subagent.
- "tags": 3-6 palavras-chave em minúsculas para busca.
- Escreva em português. Baseie-se apenas em evidências.

Responda APENAS com JSON válido, sem cercas de código, no formato:
[{"area": "overview", "summary": "...", "tags": ["..."], "document": "..."}]

## Scan automático
${scanDescription}

## Levantamentos dos subagents
${reports}`
}

function parseGenerated(raw: string): GeneratedArea[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('Resposta do revisor não contém JSON')
  const parsed = JSON.parse(text.slice(start, end + 1)) as GeneratedArea[]
  const valid = new Set(Object.keys(PROJECT_AREAS))
  return parsed.filter(
    (a) => a && valid.has(a.area) && typeof a.summary === 'string' && a.summary.trim().length > 0,
  )
}

export interface RunInitInput {
  directory: string
  providerId: string
  modelId: string
  /** Modelo dos subagents de exploração (default: o principal) */
  workerProviderId?: string
  workerModelId?: string
  /** true: sobrescreve também o resumo de áreas existentes (edições manuais) */
  force?: boolean
}

async function findAreaMemory(projectId: string, area: ProjectArea): Promise<Memory | undefined> {
  const all = await memoryService.list()
  return all.find((m) => m.kind === 'project' && m.projectId === projectId && m.area === area)
}

/**
 * Salva/atualiza a memória de uma área. Merge do re-init: o documento é
 * sempre atualizado com o novo levantamento; o resumo (texto) só é
 * sobrescrito com force — preservando edições manuais do usuário.
 */
async function saveAreaMemory(
  input: RunInitInput,
  generated: GeneratedArea,
  rootId: string | undefined,
): Promise<string> {
  const projectId = projectIdOf(input.directory)
  const existing = await findAreaMemory(projectId, generated.area)
  const tags = [...new Set([generated.area, ...generated.tags])]

  if (existing) {
    await memoryService.update(existing.id, {
      text: input.force ? generated.summary : existing.text,
      tags: [...new Set([...existing.tags, ...tags])],
    })
    await memoryService.setDocument(existing.id, generated.document)
    if (rootId) await memoryService.link(existing.id, rootId)
    return existing.id
  }

  const saved = await memoryService.save({
    kind: 'project',
    directory: input.directory,
    text: generated.summary,
    tags,
    weight: generated.area === 'overview' ? 0.9 : 0.7,
    category: AREA_CATEGORY[generated.area],
    area: generated.area,
    document: generated.document,
    relatedId: rootId,
  })
  return saved.id
}

export async function runProjectInit(input: RunInitInput): Promise<void> {
  const { directory } = input
  if (running.has(directory)) return
  running.add(directory)

  try {
    emit({ directory, stage: 'scanning' })
    const scan = await scanProject(directory)
    const scanDescription = describeScan(scan)

    // Subagents por área, em paralelo (tools read-only, modelo worker)
    const areas = planAreas(scan)
    emit({ directory, stage: 'exploring', progress: { done: 0, total: areas.length } })
    const workerModel = await resolveModel(
      input.workerProviderId ?? input.providerId,
      input.workerModelId ?? input.modelId,
    )
    const findings = await exploreAll(workerModel, scanDescription, directory, areas)

    // Agente principal: revisa, melhora e divide em memórias por área
    emit({ directory, stage: 'generating' })
    const model = await resolveModel(input.providerId, input.modelId)
    const { text } = await generateText({
      model,
      prompt: buildReviewerPrompt(scanDescription, findings),
    })
    const generated = parseGenerated(text)
    if (generated.length === 0) throw new Error('O revisor não produziu nenhuma área válida')

    emit({ directory, stage: 'saving' })
    // Root primeiro — as demais áreas nascem ligadas a ele (arestas do grafo)
    const overview = generated.find((a) => a.area === 'overview') ?? generated[0]
    const rootId = await saveAreaMemory(input, overview, undefined)
    for (const area of generated) {
      if (area === overview) continue
      await saveAreaMemory(input, area, rootId)
    }

    emit({ directory, stage: 'done', areas: generated.map((a) => a.area) })
  } catch (err) {
    emit({ directory, stage: 'error', error: err instanceof Error ? err.message : String(err) })
  } finally {
    running.delete(directory)
  }
}

/** Estado consultado pelo card automático: projeto já inicializado? rodando? */
export async function getInitStatus(directory: string): Promise<InitStatus> {
  const projectId = projectIdOf(directory)
  const overview = await findAreaMemory(projectId, 'overview')
  return {
    directory,
    initialized: overview !== undefined,
    running: running.has(directory),
  }
}
