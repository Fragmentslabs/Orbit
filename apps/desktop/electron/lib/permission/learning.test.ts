import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Each test with its own folder: the counters are a FILE, and persistence across
// a reload is one of the things being tested here.
const dir = vi.hoisted(() => ({ value: '' }))
vi.mock('../storage', () => ({ dataDir: () => dir.value }))

const { approvalCount, forgetApprovals, listLearnedRules, loadApprovalLearning, noteApproval, SUGGEST_AFTER } =
  await import('./learning')

describe('approval learning', () => {
  beforeEach(async () => {
    dir.value = await mkdtemp(path.join(tmpdir(), 'orbit-learning-'))
    // No file in the new folder: this also resets the in-memory list.
    await loadApprovalLearning()
  })

  it('counts every approval of the same rule', async () => {
    expect(approvalCount('bash:git-push')).toBe(0)
    expect(await noteApproval('bash:git-push', 'bash: git push')).toBe(1)
    expect(await noteApproval('bash:git-push', 'bash: git push origin main')).toBe(2)
    expect(approvalCount('bash:git-push')).toBe(2)
    // Another rule has its own count.
    expect(approvalCount('file:env')).toBe(0)
  })

  it('keeps the label of the last approval', async () => {
    await noteApproval('bash:git-push', 'bash: git push')
    await noteApproval('bash:git-push', 'bash: git push --force')
    expect(listLearnedRules()[0].label).toBe('bash: git push --force')
  })

  it('survives a restart', async () => {
    await noteApproval('mcp:notion', 'notion_search')
    await loadApprovalLearning()
    expect(approvalCount('mcp:notion')).toBe(1)
  })

  it('stops counting a rule that became permanent', async () => {
    await noteApproval('bash:package-install', 'bash: npm install')
    await noteApproval('bash:package-install', 'bash: npm install')
    await forgetApprovals('bash:package-install')
    expect(approvalCount('bash:package-install')).toBe(0)
    await loadApprovalLearning()
    expect(listLearnedRules()).toHaveLength(0)
  })

  it('suggests only from the threshold on', async () => {
    for (let i = 1; i <= SUGGEST_AFTER; i++) {
      expect(await noteApproval('bash:git-reset-hard', 'bash: git reset --hard')).toBe(i)
    }
    // The card compares the count it receives with the same constant.
    expect(approvalCount('bash:git-reset-hard')).toBe(SUGGEST_AFTER)
  })

  it('lists the most recent first', async () => {
    await noteApproval('bash:sudo', 'bash: sudo')
    await noteApproval('file:env', 'write: .env')
    const list = listLearnedRules()
    expect(list[0].ruleId).toBe('file:env')
    expect(list[1].ruleId).toBe('bash:sudo')
  })
})
