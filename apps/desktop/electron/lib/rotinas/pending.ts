import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Rotina, RotinaPendente } from '@shared/rotinas'
import { criarRotina } from './index'

/**
 * Propostas de rotina feitas pelo agente (tool rotinas_manage, ação "criar"):
 * ficam em staging (orbit-data/rotinas-pending/<id>.json) até a pessoa clicar
 * "Criar rotina" no card da conversa — nada do agente vai direto para o
 * rotinas.json sem revisão, a mesma regra do gerador do modal.
 *
 * O id da proposta É o id da rotina aprovada: é o que deixa o card reconhecer
 * a rotina criada mesmo depois de um reload (o equivalente do slug das skills).
 */

function pendingDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'rotinas-pending')
}

/** O id vira nome de arquivo — precisa ser inofensivo. */
function idValido(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}

export function novoIdProposta(): string {
  return `rotprop_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export async function proporRotina(proposta: RotinaPendente): Promise<RotinaPendente> {
  const dir = pendingDir()
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${proposta.id}.json`), JSON.stringify(proposta, null, 2), 'utf8')
  return proposta
}

export async function listarRotinasPendentes(): Promise<RotinaPendente[]> {
  let arquivos: string[]
  try {
    arquivos = await fsp.readdir(pendingDir())
  } catch {
    return []
  }
  const propostas: RotinaPendente[] = []
  for (const arquivo of arquivos) {
    if (!arquivo.endsWith('.json')) continue
    try {
      const bruta = JSON.parse(await fsp.readFile(path.join(pendingDir(), arquivo), 'utf8')) as RotinaPendente
      // Mínimo que define uma proposta; o resto é validado na hora de criar.
      if (bruta && typeof bruta.id === 'string' && typeof bruta.titulo === 'string') propostas.push(bruta)
    } catch {
      // proposta corrompida — ignora, como as skills pendentes
    }
  }
  return propostas.sort((a, b) => b.criadoEm - a.criadoEm)
}

/**
 * Aprova a proposta: cria a rotina (com o MESMO id) e descarta o staging.
 * O evento 'rotina' sai da própria criação, como qualquer rotina nova.
 */
export async function aprovarRotinaPendente(id: string): Promise<Rotina | null> {
  if (!idValido(id)) return null
  const arquivo = path.join(pendingDir(), `${id}.json`)
  let proposta: RotinaPendente
  try {
    proposta = JSON.parse(await fsp.readFile(arquivo, 'utf8')) as RotinaPendente
  } catch {
    return null
  }
  const rotina = await criarRotina({
    id: proposta.id,
    titulo: proposta.titulo,
    prompt: proposta.prompt,
    agenda: proposta.agenda,
    modelo: proposta.modelo,
    modos: proposta.modos,
    mode: proposta.mode,
    pastas: proposta.pastas,
    visionModel: proposta.visionModel,
    ativa: true,
  })
  await fsp.rm(arquivo, { force: true })
  return rotina
}

export async function descartarRotinaPendente(id: string): Promise<void> {
  if (!idValido(id)) return
  await fsp.rm(path.join(pendingDir(), `${id}.json`), { force: true })
}
