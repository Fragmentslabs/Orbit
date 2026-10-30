#!/usr/bin/env node
// Phase 0 of Computer Use: measures the JXA bridge BEFORE any product
// decision. Runs the SAME bridge as the app (electron/lib/computer/bridges/macos.js)
// against the open apps and prints a table with the approval criteria
// defined in docs/computer-use.md.
//
// Usage:
//   node scripts/cu-probe.mjs                 measures everything possible with what is open
//   node scripts/cu-probe.mjs --runs 5        repetitions per measurement (p95 comes from there)
//   node scripts/cu-probe.mjs --frozen        freezes TextEdit (SIGSTOP) and measures the timeout
//   node scripts/cu-probe.mjs --json          JSON output (to paste into the doc)
//
// Permissions: whoever runs the probe is the terminal (or the app that opened the terminal).
// To measure AX and capture, grant Accessibility and Screen Recording to it.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.error('The Phase 0 probe only runs on macOS.')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(here, '..', 'electron', 'lib', 'computer', 'bridges', 'macos.js')
const args = process.argv.slice(2)
const RUNS = Number(args[args.indexOf('--runs') + 1]) || 3
const JSON_OUT = args.includes('--json')
const FROZEN = args.includes('--frozen')

// The same limits the doc sets as the approval criterion.
const CRITERIA = {
  observeP95Ms: 1500,
  frozenMs: 3000,
  captureP95Ms: 600,
}

const PROBE_APPS = [
  { bundleId: 'com.apple.TextEdit', label: 'TextEdit', kind: 'native' },
  { bundleId: 'com.apple.Safari', label: 'Safari', kind: 'native' },
  { bundleId: 'com.google.Chrome', label: 'Chrome', kind: 'chromium' },
  { bundleId: 'com.microsoft.VSCode', label: 'VS Code', kind: 'chromium' },
  { bundleId: 'com.tinyspeck.slackmacgap', label: 'Slack', kind: 'chromium' },
  { bundleId: 'com.anthropic.claudefordesktop', label: 'Claude (Electron)', kind: 'chromium' },
]

function bridge(op, opArgs = {}, timeoutMs = 15_000) {
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', BRIDGE, JSON.stringify({ op, args: opArgs })],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const ms = Date.now() - started
        if (err && !stdout) return resolve({ ok: false, ms, error: { code: err.killed ? 'timeout' : 'spawn', message: String(err.message) } })
        try {
          resolve({ ...JSON.parse(stdout), ms })
        } catch {
          resolve({ ok: false, ms, error: { code: 'parse', message: stdout.slice(0, 200) } })
        }
      },
    )
  })
}

function capture(windowId) {
  const file = path.join(os.tmpdir(), `cu-probe-${process.pid}-${windowId}.png`)
  const started = Date.now()
  return new Promise((resolve) => {
    execFile('screencapture', ['-x', '-o', `-l${windowId}`, '-t', 'png', file], { timeout: 10_000 }, (err) => {
      const ms = Date.now() - started
      let bytes = 0
      try {
        bytes = fs.statSync(file).size
        fs.unlinkSync(file)
      } catch {}
      resolve({ ok: !err && bytes > 0, ms, bytes, error: err ? String(err.message).trim() : null })
    })
  })
}

function p95(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

const report = { at: new Date().toISOString(), macos: os.release(), runs: RUNS, checks: [] }
function check(name, pass, detail) {
  report.checks.push({ name, pass, detail })
}

// 1. Permissions and fixed cost of one invocation
const perms = await bridge('perms')
report.permissions = perms.ok ? perms.result : perms.error
report.spawnMs = perms.ms
check('Accessibility granted to the process that runs the probe', perms.ok && perms.result.accessibility, perms.ok ? '' : perms.error?.message)

// 2. Window list (CGWindowList + NSWorkspace)
const listTimes = []
let snapshot = null
for (let i = 0; i < RUNS; i++) {
  const r = await bridge('apps')
  listTimes.push(r.ms)
  if (r.ok) snapshot = r.result
}
report.appsP95Ms = p95(listTimes)
report.windowTitlesVisible = Boolean(snapshot?.windows.some((w) => w.title))
check('List of apps and windows', Boolean(snapshot), `p95 ${report.appsP95Ms} ms`)

// 3. AX tree and capture per open app
report.apps = []
for (const probe of PROBE_APPS) {
  const app = snapshot?.apps.find((a) => a.bundleId === probe.bundleId)
  if (!app) {
    report.apps.push({ ...probe, running: false })
    continue
  }
  const win = snapshot.windows.find((w) => w.pid === app.pid)
  const entry = { ...probe, running: true, pid: app.pid, windowId: win?.id ?? null }
  if (!win) {
    report.apps.push({ ...entry, note: 'no visible window' })
    continue
  }
  for (const enhance of probe.kind === 'chromium' ? [false, true] : [false]) {
    const times = []
    let last = null
    for (let i = 0; i < RUNS; i++) {
      // Like the app: only the first read with the flag waits for Chromium to build the tree.
      const enhanceWaitMs = enhance && i === 0 ? 450 : 0
      const r = await bridge('tree', { pid: app.pid, window: { frame: win.frame, title: win.title }, maxNodes: 250, enhance, enhanceWaitMs })
      times.push(r.ms)
      last = r
    }
    const key = enhance ? 'treeEnhanced' : 'tree'
    entry[key] = last.ok
      ? { p95Ms: p95(times), nodes: last.result.nodes.length, bridgeMs: last.result.ms, truncated: last.result.truncated, omitted: last.result.omitted, enhanced: last.result.enhanced }
      : { error: last.error }
  }
  if (probe.kind === 'chromium' && entry.treeEnhanced?.enhanced) await bridge('restore', { pids: [app.pid] })
  const caps = []
  let lastCap = null
  for (let i = 0; i < RUNS; i++) {
    lastCap = await capture(win.id)
    caps.push(lastCap.ms)
  }
  entry.capture = lastCap.ok ? { p95Ms: p95(caps), kb: Math.round(lastCap.bytes / 1024) } : { error: lastCap.error }
  report.apps.push(entry)
}

for (const a of report.apps.filter((x) => x.running && x.tree)) {
  if (a.tree.error) {
    check(`Tree ${a.label}`, false, a.tree.error.message)
    continue
  }
  if (a.kind === 'native') {
    check(`Observe ${a.label} p95 < ${CRITERIA.observeP95Ms} ms`, a.tree.p95Ms < CRITERIA.observeP95Ms, `${a.tree.p95Ms} ms, ${a.tree.nodes} nodes`)
  } else {
    const plain = a.tree.nodes
    const rich = a.treeEnhanced?.nodes ?? 0
    check(`Tree ${a.label} not empty with the accessibility flag`, rich > 20, `${plain} nodes without flag → ${rich} with flag`)
  }
  if (a.capture) {
    check(
      `Capture ${a.label} p95 < ${CRITERIA.captureP95Ms} ms`,
      Boolean(a.capture.p95Ms && a.capture.p95Ms < CRITERIA.captureP95Ms),
      a.capture.error ?? `${a.capture.p95Ms} ms, ${a.capture.kb} KB`,
    )
  }
}

// 4. Frozen app: the messaging timeout has to hold the observation
if (FROZEN) {
  const textEdit = report.apps.find((a) => a.bundleId === 'com.apple.TextEdit' && a.windowId)
  if (!textEdit) {
    check('Timeout with a frozen app', false, 'open TextEdit with a window for this test')
  } else {
    const win = snapshot.windows.find((w) => w.id === textEdit.windowId)
    process.kill(textEdit.pid, 'SIGSTOP')
    try {
      const r = await bridge('tree', { pid: textEdit.pid, window: { frame: win.frame }, maxNodes: 250 }, 20_000)
      report.frozen = { ms: r.ms, ok: r.ok, truncated: r.result?.truncated ?? null, error: r.error ?? null }
      check(`Frozen app answers in < ${CRITERIA.frozenMs} ms`, r.ms < CRITERIA.frozenMs, `${r.ms} ms (${r.ok ? r.result.truncated ?? 'complete' : r.error.code})`)
    } finally {
      process.kill(textEdit.pid, 'SIGCONT')
    }
  }
}

// 5. Warm process: how much of the time is only starting osascript
const warmStart = Date.now()
await new Promise((resolve) => {
  const child = spawn('osascript', ['-l', 'JavaScript', '-e', 'function run() { return "1" }'])
  child.on('close', resolve)
})
report.coldSpawnMs = Date.now() - warmStart

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`\nComputer Use — Phase 0 (${report.at}, Darwin ${report.macos}, ${RUNS} runs)\n`)
  console.log(`Starting osascript: ${report.coldSpawnMs} ms · minimum bridge invocation: ${report.spawnMs} ms`)
  console.log(`Visible window titles (Screen Recording): ${report.windowTitlesVisible ? 'yes' : 'no'}\n`)
  console.log('| App | Tree p95 | Nodes | With flag | Capture p95 |')
  console.log('|---|---|---|---|---|')
  for (const a of report.apps) {
    if (!a.running) {
      console.log(`| ${a.label} | not open | | | |`)
      continue
    }
    const tree = a.tree?.error ? a.tree.error.code : a.tree ? `${a.tree.p95Ms} ms` : a.note ?? '—'
    const nodes = a.tree?.nodes ?? '—'
    const rich = a.treeEnhanced ? (a.treeEnhanced.error ? a.treeEnhanced.error.code : `${a.treeEnhanced.nodes} nodes`) : '—'
    const cap = a.capture ? (a.capture.error ? 'denied' : `${a.capture.p95Ms} ms (${a.capture.kb} KB)`) : '—'
    console.log(`| ${a.label} | ${tree} | ${nodes} | ${rich} | ${cap} |`)
  }
  console.log('\nCriteria:')
  for (const c of report.checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  console.log('')
}
