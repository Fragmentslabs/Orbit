import fsp from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../storage'

/**
 * What has already been approved, counted per rule.
 *
 * It answers one question at the moment of the request: "this same rule has been
 * allowed N times — should it stop asking?". The dialog offers "Always", but it
 * lives inside a dropdown nobody opens. Without a count, the same question comes
 * back every turn, forever, and the user has no reason to believe the choice is
 * permanent — which is how a permission system turns into a reflex of clicking
 * "Allow once" (the very reflex that makes it useless).
 *
 * A rule that becomes permanent (trust-rules.json) loses its counter here: the
 * count belongs to what is STILL being asked, not to what is already settled.
 */

const LEARNING_FILE = 'approval-learning.json'

/** Approvals of the same rule — across turns and chats — before the card says so. */
export const SUGGEST_AFTER = 3

export interface LearnedRule {
  ruleId: string
  /** The label the card showed the last time ("bash: git push"). */
  label: string
  approvals: number
  firstAt: number
  lastAt: number
}

let rules: LearnedRule[] = []

function filePath(): string {
  return path.join(dataDir(), LEARNING_FILE)
}

export async function loadApprovalLearning(): Promise<void> {
  try {
    const raw = await fsp.readFile(filePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    rules = Array.isArray(parsed) ? parsed.filter(isLearnedRule) : []
  } catch {
    rules = []
  }
}

function isLearnedRule(value: unknown): value is LearnedRule {
  const entry = value as LearnedRule | null
  return !!entry && typeof entry.ruleId === 'string' && typeof entry.approvals === 'number'
}

async function save(): Promise<void> {
  await fsp.mkdir(dataDir(), { recursive: true })
  await fsp.writeFile(filePath(), JSON.stringify(rules, null, 2), 'utf8')
}

export function approvalCount(ruleId: string): number {
  return rules.find((r) => r.ruleId === ruleId)?.approvals ?? 0
}

/**
 * One more approval of this rule; returns the new count.
 *
 * Every approval counts, including "Allow once": the repetition the suggestion is
 * about is exactly the one that never becomes permanent.
 */
export async function noteApproval(ruleId: string, label: string): Promise<number> {
  const now = Date.now()
  const existing = rules.find((r) => r.ruleId === ruleId)
  if (existing) {
    existing.approvals += 1
    existing.lastAt = now
    // The title carries the command of the moment ("bash: git push origin main"),
    // so the last one wins: it is what the rules screen shows.
    existing.label = label
    await save()
    return existing.approvals
  }
  rules.push({ ruleId, label, approvals: 1, firstAt: now, lastAt: now })
  await save()
  return 1
}

/** The rule became permanent: it stops being asked, so it stops being counted. */
export async function forgetApprovals(ruleId: string): Promise<void> {
  const before = rules.length
  rules = rules.filter((r) => r.ruleId !== ruleId)
  if (rules.length !== before) await save()
}

/** Most recent first — the order the rules screen reads in. */
export function listLearnedRules(): LearnedRule[] {
  // Reversed BEFORE sorting so that two approvals in the same millisecond keep
  // the newest first (sort is stable): without it, the order of the screen
  // depends on the clock's resolution instead of on what happened last.
  return [...rules].reverse().sort((a, b) => b.lastAt - a.lastAt)
}
