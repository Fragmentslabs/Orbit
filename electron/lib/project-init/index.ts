import { generateText, stepCountIs, streamText, type LanguageModel, type ToolSet } from 'ai'
import { BrowserWindow } from 'electron'
import type { InitEvent, InitStage, Memory, ProjectArea, ProjectCategory } from '../../../shared/memory'
import { PROJECT_AREAS } from '../../../shared/memory'
import { projectIdOf } from '../memory/domain'
import * as memoryService from '../memory/service'
import { resolveModel } from '../providers'
import { createGlobTool, createGrepTool, createListTool, createReadTool } from '../tools/files'
import type { ToolContext } from '../tools/context'
import { describeScan, scanProject, type ProjectScan } from './scanner'

/**
 * Pipeline do /init (incremental): scanner → subagents em paralelo (um por
 * área, streaming) e, CONFORME cada um termina, o agente principal revisa o
 * levantamento, salva a memória da área e — quando o achado complementa uma
 * área já salva — edita o documento anterior. Nada espera o lote inteiro:
 * exploração e consolidação correm juntas (a consolidação é serializada para
 * os complementos não se atropelarem).
 */

const running = new Set<string>()
const WORKER_CONCURRENCY = 3
const WORKER_MAX_STEPS = 12
const WORKER_TIMEOUT_MS = 4 * 60 * 1000

function emit(stage: InitStage, data: Partial<InitEvent>) {
  const event: InitEvent = { directory: '', stage, ...data } as InitEvent
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('init:event', event)
  }
}

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

/** Callbacks de UI: o chat-engine transforma em parts (acordeons) da mensagem. */
export interface InitHooks {
  /** Narração do agente principal (acordeon de cima) */
  onMainDelta?: (delta: string) => void
  onAgentStart?: (area: ProjectArea, label: string) => void
  onAgentDelta?: (area: ProjectArea, delta: string) => void
  onAgentDone?: (area: ProjectArea, ok: boolean) => void
}

interface ParsedFindings {
  summary: string
  tags: string[]
  document: string
}

function fallbackParse(text: string): ParsedFindings {
  const tagsMatch = text.match(/^TAGS:\s*(.+)$/im)
  const tags = tagsMatch
    ? tagsMatch[1].split(/[,;]\s*/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    : []
  const cleaned = text.replace(/^TAGS:.*$/im, '').trim()
  const summary = cleaned.split(/\n\n+/).find(Boolean)?.trim().slice(0, 500) ?? cleaned.slice(0, 500)
  return { summary, tags, document: cleaned }
}

/** Resumo curto dos argumentos de uma tool p/ narração do worker */
function toolCallLine(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  const arg = obj.filePath ?? obj.dirPath ?? obj.pattern ?? obj.query ?? ''
  const short = typeof arg === 'string' ? arg.split(/[\\/]/).slice(-2).join('/') : ''
  return `\n\`→ ${toolName}${short ? ` ${short}` : ''}\`\n\n`
}

interface AreaResult {
  area: Exclude<ProjectArea, 'overview'>
  raw: string
  failed: boolean
}

/** Subagent de uma área: explora com tools read-only, streamando o que faz. */
async function exploreArea(
  model: LanguageModel,
  scanDescription: string,
  directory: string,
  area: Exclude<ProjectArea, 'overview'>,
  hooks: InitHooks,
): Promise<AreaResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS)
  hooks.onAgentStart?.(area, PROJECT_AREAS[area].label)
  let buffer = ''
  try {
    const result = streamText({
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
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        buffer += part.text
        hooks.onAgentDelta?.(area, part.text)
      } else if (part.type === 'tool-call') {
        hooks.onAgentDelta?.(area, toolCallLine(part.toolName, part.input))
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
    }
    hooks.onAgentDone?.(area, true)
    return { area, raw: buffer, failed: false }
  } catch (err) {
    hooks.onAgentDelta?.(area, `\n_(exploração interrompida: ${err instanceof Error ? err.message : String(err)})_`)
    hooks.onAgentDone?.(area, false)
    return { area, raw: buffer, failed: true }
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Consolidação incremental (agente principal)
// ---------------------------------------------------------------------------

interface RefineOutput extends ParsedFindings {
  /** Complementos a áreas já salvas: o achado deste worker enriquece docs anteriores */
  complements?: { area: ProjectArea; addition: string }[]
}

function parseRefineJson(raw: string): RefineOutput | null {
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const parsed = JSON.parse(text.slice(start, end + 1)) as RefineOutput
    if (typeof parsed.summary !== 'string' || typeof parsed.document !== 'string') return null
    return {
      summary: parsed.summary.trim(),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).toLowerCase()) : [],
      document: parsed.document,
      complements: Array.isArray(parsed.complements)
        ? parsed.complements.filter((c) => c && typeof c.addition === 'string' && c.area in PROJECT_AREAS)
        : [],
    }
  } catch {
    return null
  }
}

/** Revisão de um levantamento pelo agente principal: condensa, remove
 * especulação e aponta complementos para áreas já consolidadas. */
async function refineFindings(
  model: LanguageModel,
  area: ProjectArea,
  raw: string,
  savedSummaries: Map<ProjectArea, string>,
): Promise<RefineOutput> {
  const savedList = [...savedSummaries.entries()]
    .filter(([a]) => a !== area)
    .map(([a, summary]) => `- "${a}" (${PROJECT_AREAS[a].label}): ${summary}`)
    .join('\n')
  const { text } = await generateText({
    model,
    system:
      'Você é o agente principal do onboarding do Orbit. Revise o levantamento de um subagent: remova especulação, corrija exageros, condense e estruture. Responda APENAS com JSON válido.',
    prompt: `Área: "${area}" (${PROJECT_AREAS[area].label})

Levantamento do subagent:
${raw}

Áreas já consolidadas (para decidir complementos):
${savedList || '(nenhuma ainda)'}

Responda com JSON:
{
  "summary": "2-4 frases objetivas — entra no contexto do agente",
  "tags": ["3-6 palavras-chave minúsculas"],
  "document": "markdown revisado e estruturado da área (caminhos reais, comandos)",
  "complements": [{"area": "id-de-area-ja-consolidada", "addition": "trecho markdown que enriquece aquele doc"}]
}
"complements" só quando este levantamento traz algo que pertence a outra área já consolidada (senão []).`,
  })
  return parseRefineJson(text) ?? { ...fallbackParse(raw), complements: [] }
}

async function findAreaMemory(projectId: string, area: ProjectArea): Promise<Memory | undefined> {
  const all = await memoryService.list()
  return all.find((m) => m.kind === 'project' && m.projectId === projectId && m.area === area)
}

async function saveAreaMemory(
  directory: string,
  area: ProjectArea,
  parsed: ParsedFindings,
  rootId: string | undefined,
  force?: boolean,
): Promise<string> {
  const projectId = projectIdOf(directory)
  const existing = await findAreaMemory(projectId, area)
  const tags = [...new Set([area, ...parsed.tags])]

  if (existing) {
    // Merge do re-init: doc sempre atualizado; resumo só com --force
    await memoryService.update(existing.id, {
      text: force ? parsed.summary : existing.text,
      tags: [...new Set([...existing.tags, ...tags])],
    })
    await memoryService.setDocument(existing.id, parsed.document)
    if (rootId) await memoryService.link(existing.id, rootId)
    return existing.id
  }

  const saved = await memoryService.save({
    kind: 'project',
    directory,
    text: parsed.summary,
    tags,
    weight: area === 'overview' ? 0.9 : 0.7,
    category: AREA_CATEGORY[area],
    area,
    document: parsed.document,
    relatedId: rootId,
  })
  return saved.id
}

/** Aplica um complemento ao doc de uma área já salva (append com separador). */
async function applyComplement(
  savedIds: Map<ProjectArea, string>,
  from: ProjectArea,
  complement: { area: ProjectArea; addition: string },
): Promise<boolean> {
  const targetId = savedIds.get(complement.area)
  if (!targetId || !complement.addition.trim()) return false
  const full = await memoryService.getFull(targetId)
  if (!full) return false
  const current = full.document ?? full.memory.text
  const appended = `${current}\n\n---\n\n_Complemento (via análise de ${PROJECT_AREAS[from].label}):_\n\n${complement.addition.trim()}`
  await memoryService.setDocument(targetId, appended)
  return true
}

export interface RunInitInput {
  directory: string
  providerId: string
  modelId: string
  workerProviderId?: string
  workerModelId?: string
  force?: boolean
  /** Workers paralelos por análise (1-6, padrão 3). Mais workers = mais
   * rapidez, mas mais tokens simultâneos. */
  concurrency?: number
  hooks?: InitHooks
}

export async function runProjectInit(input: RunInitInput): Promise<string[]> {
  const { directory, force } = input
  const hooks = input.hooks ?? {}
  if (running.has(directory)) {
    throw new Error('Já existe uma análise em andamento para esta pasta.')
  }
  running.add(directory)

  const main = (text: string) => hooks.onMainDelta?.(text)
  const savedIds = new Map<ProjectArea, string>()
  const savedSummaries = new Map<ProjectArea, string>()

  try {
    // 1. Scanner determinístico
    emit('scanning', { directory })
    main('Escaneando estrutura e configs do projeto…\n')
    const scan = await scanProject(directory)
    const scanDescription = describeScan(scan)
    const areaList = planAreas(scan)
    main(
      `Stack detectada: ${[...scan.stack, ...scan.frameworks].join(', ') || 'não identificada'}.\n` +
        `Vou investigar ${areaList.length} áreas em paralelo: ${areaList.map((a) => PROJECT_AREAS[a].label).join(', ')}.\n\n`,
    )

    const model = await resolveModel(input.providerId, input.modelId)
    const workerModel = await resolveModel(
      input.workerProviderId ?? input.providerId,
      input.workerModelId ?? input.modelId,
    )

    // 2. Overview inicial a partir do scan — o node raiz nasce cedo para as
    // áreas já se ligarem a ele; complementos o enriquecem depois
    const { text: overviewText } = await generateText({
      model,
      system:
        'Você é um analista de projetos. Gere uma visão geral concisa em markdown: sobre o que é o projeto, stack e tecnologias, estrutura geral.',
      prompt: `Com base no scan abaixo, escreva a visão geral do projeto:\n\n${scanDescription}`,
    })
    const overview: ParsedFindings = {
      summary: overviewText.trim().split(/\n\n+/).find(Boolean)?.trim().slice(0, 500) ?? '',
      tags: ['overview', scan.name.toLowerCase()],
      document: overviewText.trim(),
    }
    const rootId = await saveAreaMemory(directory, 'overview', overview, undefined, force)
    savedIds.set('overview', rootId)
    savedSummaries.set('overview', overview.summary)
    main(`✓ **${PROJECT_AREAS.overview.label}** salvo — é o node central do grafo.\n`)

    // 3. Exploração paralela + consolidação incremental. A consolidação é
    // serializada (chain) para complementos não conflitarem entre si; os
    // workers seguem explorando enquanto o principal consolida.
    const done: ProjectArea[] = ['overview']
    let consolidated = 0
    let refineChain: Promise<void> = Promise.resolve()

    const consolidate = (result: AreaResult) =>
      (refineChain = refineChain.then(async () => {
        consolidated++
        const progress = `(${consolidated}/${areaList.length})`
        if (result.failed && !result.raw.trim()) {
          main(`✗ **${PROJECT_AREAS[result.area].label}** falhou sem levantamento — pulando. ${progress}\n`)
          return
        }
        main(`Revisando **${PROJECT_AREAS[result.area].label}**… ${progress}\n`)
        try {
          const refined = await refineFindings(model, result.area, result.raw, savedSummaries)
          const id = await saveAreaMemory(directory, result.area, refined, rootId, force)
          savedIds.set(result.area, id)
          savedSummaries.set(result.area, refined.summary)
          done.push(result.area)
          main(`✓ **${PROJECT_AREAS[result.area].label}** consolidado e salvo.\n`)
          for (const complement of refined.complements ?? []) {
            if (await applyComplement(savedIds, result.area, complement)) {
              main(`  ↳ complementei **${PROJECT_AREAS[complement.area].label}** com um achado desta área.\n`)
            }
          }
        } catch (err) {
          // Revisão falhou: salva o levantamento bruto para não perder o trabalho
          const fallback = fallbackParse(result.raw)
          const id = await saveAreaMemory(directory, result.area, fallback, rootId, force)
          savedIds.set(result.area, id)
          savedSummaries.set(result.area, fallback.summary)
          done.push(result.area)
          main(
            `✓ **${PROJECT_AREAS[result.area].label}** salvo sem revisão (revisor falhou: ${err instanceof Error ? err.message : String(err)}).\n`,
          )
        }
      }))

    const queue = [...areaList]
    const maxWorkers = Math.max(1, Math.min(input.concurrency ?? WORKER_CONCURRENCY, 6, queue.length))
    const workers = Array.from({ length: maxWorkers }, async () => {
      while (queue.length > 0) {
        const area = queue.shift()!
        const result = await exploreArea(workerModel, scanDescription, directory, area, hooks)
        // Dispara a consolidação e segue para a próxima área sem esperar
        void consolidate(result)
      }
    })
    await Promise.all(workers)
    await refineChain

    main(`\nAnálise concluída: ${done.length} memórias no grafo do projeto.`)
    emit('done', { directory, areas: done })
    return done
  } catch (err) {
    emit('error', { directory, error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    running.delete(directory)
  }
}

export async function getInitStatus(directory: string): Promise<{ directory: string; initialized: boolean; running: boolean }> {
  const projectId = projectIdOf(directory)
  const overview = await findAreaMemory(projectId, 'overview')
  return {
    directory,
    initialized: overview !== undefined,
    running: running.has(directory),
  }
}
