import fsp from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../storage'

const TRUST_FILE = 'trust-rules.json'

interface TrustEntry {
  ruleId: string
  createdAt: number
}

let rules: TrustEntry[] = []

function filePath(): string {
  return path.join(dataDir(), TRUST_FILE)
}

export async function loadTrustRules(): Promise<void> {
  try {
    const raw = await fsp.readFile(filePath(), 'utf8')
    rules = JSON.parse(raw)
    if (!Array.isArray(rules)) rules = []
  } catch {
    rules = []
  }
}

async function save(): Promise<void> {
  await fsp.mkdir(dataDir(), { recursive: true })
  await fsp.writeFile(filePath(), JSON.stringify(rules, null, 2), 'utf8')
}

export function checkTrust(ruleId: string): boolean {
  return rules.some((r) => r.ruleId === ruleId)
}

export async function addTrust(ruleId: string): Promise<void> {
  if (rules.some((r) => r.ruleId === ruleId)) return
  rules.push({ ruleId, createdAt: Date.now() })
  await save()
}

export async function removeTrust(ruleId: string): Promise<void> {
  rules = rules.filter((r) => r.ruleId !== ruleId)
  await save()
}

export function listTrustRules(): TrustEntry[] {
  return [...rules]
}
