import { generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai'
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
 * Pipeline do /init: scanner → overview → subagents por área (paralelo).
 * Cada subagent salva a memória da sua área assim que termina — não há um
 * passo "revisor" único que pode falhar e perder todo o progresso.
 * Se um subagent falha, os demais continuam normalmente.
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

interface ParsedFindings {
  summary: string
  tags: string[]
  document: string
}

function parseSubagentOutput(text: string): ParsedFindings {
  const tagsMatch = text.match(/^TAGS:\s*(.+)$/im)
  const tags = tagsMatch
    ? tagsMatch[1].split(/[,;]\s*/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    : []
  const cleaned = text.replace(/^TAGS:.*$/im, '').trim()
  const paragraphs = cleaned.split(/\n\n+/).filter(Boolean)
  const summary = paragraphs[0]?.trim().slice(0, 500) ?? cleaned.slice(0, 500)
  return { summary, tags, document: cleaned }
}

async function generateOverview(
  model: LanguageModel,
  scan: ProjectScan,
  scanDescription: string,
): Promise<ParsedFindings> {
  const { text } = await generateText({
    model,
    system: 'Você é um analista de projetos. Gere uma visão geral concisa em markdown com base nos dados do scan.',
    prompt: `Com base no scan abaixo, escreva uma visão geral do projeto em markdown:\n\n${scanDescription}`,
  })
  const cleaned = text.trim()
  return {
    summary: cleaned.split('\n\n')[0]?.trim() ?? cleaned.slice(0, 500),
    tags: ['overview', scan.name.toLowerCase()],
    document: cleaned,
  }
}

interface AreaResult {
  area: Exclude<ProjectArea, 'overview'>
  parsed: ParsedFindings | null
  failed: boolean
}

async function exploreArea(
  model: LanguageModel,
  scanDescription: string,
  directory: string,
  area: Exclude<ProjectArea, 'overview'>,
): Promise<AreaResult> {
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
    return { area, parsed: parseSubagentOutput(text), failed: false }
  } catch (err) {
    return {
      area,
      parsed: null,
      failed: true,
    }
  } finally {
    clearTimeout(timeout)
  }
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

export interface RunInitInput {
  directory: string
  providerId: string
  modelId: string
  workerProviderId?: string
  workerModelId?: string
  force?: boolean
  /** Chamado a cada progresso para atualizar a UI em tempo real */
  onProgress?: (event: { area: ProjectArea; done: number; total: number; stage: string; label: string }) => void
}

function progressLabel(area: ProjectArea): string {
  return PROJECT_AREAS[area]?.label ?? area
}

export async function runProjectInit(input: RunInitInput): Promise<string[]> {
  const { directory, force, onProgress } = input
  if (running.has(directory)) return []
  running.add(directory)

  const areas: ProjectArea[] = []

  try {
    // Fase 1: Scanner determinístico
    emit('scanning', { directory })
    const scan = await scanProject(directory)
    const scanDescription = describeScan(scan)
    const areaList = planAreas(scan)
    const totalAreas = 1 + areaList.length // overview + subagents
    const prog = (stage: string, area: ProjectArea, done: number) =>
      onProgress?.({ stage, area, label: progressLabel(area), done, total: totalAreas })

    // Fase 2: Overview (única chamada LLM necessária)
    prog('overview', 'overview', 0)
    const model = await resolveModel(input.providerId, input.modelId)
    const overviewResult = await generateOverview(model, scan, scanDescription)
    const overviewId = await saveAreaMemory(directory, 'overview', overviewResult, undefined, force)
    areas.push('overview')

    // Fase 3: Subagents — cada um salva sua área assim que termina
    const workerModel = await resolveModel(
      input.workerProviderId ?? input.providerId,
      input.workerModelId ?? input.modelId,
    )

    let completed = 0
    const queue = [...areaList]
    const workers = Array.from({ length: Math.min(WORKER_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const area = queue.shift()!
        const result = await exploreArea(workerModel, scanDescription, directory, area)
        completed++
        prog('exploring', area, completed)

        if (!result.failed && result.parsed) {
          await saveAreaMemory(directory, area, result.parsed, overviewId, force)
          areas.push(area)
        }
        // Se falhou, apenas não salva — não bloqueia as demais áreas
      }
    })

    await Promise.all(workers)
    prog('done', 'overview', totalAreas)
    emit('done', { directory, areas })
    return areas
  } catch (err) {
    emit('error', { directory, error: err instanceof Error ? err.message : String(err) })
    return areas
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
