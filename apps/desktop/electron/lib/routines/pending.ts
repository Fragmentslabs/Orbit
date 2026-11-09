import fsp from 'node:fs/promises'
import path from 'node:path'
import type { PendingRoutine, Routine } from '@shared/routines'
import { createRoutine } from './index'
import { ensureMigrated, proposalsDir } from './repo'

/**
 * Routine proposals made by the agent (tool routines_manage, action "create"):
 * they stay in staging (orbit-data/routine-proposals/<id>.json) until the person
 * clicks "Create routine" in the conversation card — nothing the agent produces
 * goes straight into routines.json without review, the same rule as the modal's
 * generator.
 *
 * The proposal id IS the id of the approved routine: that is what lets the card
 * recognise the created routine even after a reload (the equivalent of the
 * skills' slug).
 */

/** The id becomes a file name — it has to be harmless. */
function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}

export function newProposalId(): string {
  return `routprop_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export async function proposeRoutine(proposal: PendingRoutine): Promise<PendingRoutine> {
  await ensureMigrated()
  const dir = proposalsDir()
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2), 'utf8')
  return proposal
}

export async function listPendingRoutines(): Promise<PendingRoutine[]> {
  await ensureMigrated()
  let files: string[]
  try {
    files = await fsp.readdir(proposalsDir())
  } catch {
    return []
  }
  const proposals: PendingRoutine[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(proposalsDir(), file), 'utf8')) as PendingRoutine
      // Minimum that defines a proposal; the rest is validated when it is created.
      if (raw && typeof raw.id === 'string' && typeof raw.title === 'string') proposals.push(raw)
    } catch {
      // corrupted proposal — ignored, like the pending skills
    }
  }
  return proposals.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Approves the proposal: creates the routine (with the SAME id) and clears the
 * staging file. The 'routine' event comes out of the creation itself, like any
 * new routine.
 */
export async function approvePendingRoutine(id: string): Promise<Routine | null> {
  if (!validId(id)) return null
  await ensureMigrated()
  const file = path.join(proposalsDir(), `${id}.json`)
  let proposal: PendingRoutine
  try {
    proposal = JSON.parse(await fsp.readFile(file, 'utf8')) as PendingRoutine
  } catch {
    return null
  }
  const routine = await createRoutine({
    id: proposal.id,
    title: proposal.title,
    prompt: proposal.prompt,
    schedule: proposal.schedule,
    model: proposal.model,
    modes: proposal.modes,
    mode: proposal.mode,
    folders: proposal.folders,
    visionModel: proposal.visionModel,
    agent: proposal.agent,
    team: proposal.team,
    tokenBudget: proposal.tokenBudget,
    // Approving the card is what approves the scripts it shows (see createRoutine).
    scripts: proposal.scripts,
    trigger: proposal.trigger,
    active: true,
  })
  await fsp.rm(file, { force: true })
  return routine
}

export async function discardPendingRoutine(id: string): Promise<void> {
  if (!validId(id)) return
  await ensureMigrated()
  await fsp.rm(path.join(proposalsDir(), `${id}.json`), { force: true })
}
