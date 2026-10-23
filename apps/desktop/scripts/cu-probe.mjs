#!/usr/bin/env node
// Fase 0 do Computer Use: mede a bridge JXA ANTES de qualquer decisão de
// produto. Roda a MESMA bridge do app (electron/lib/computer/bridges/macos.js)
// contra os apps abertos e imprime uma tabela com os critérios de aprovação
// definidos em docs/computer-use.md.
//
// Uso:
//   node scripts/cu-probe.mjs                 mede tudo que der com o que está aberto
//   node scripts/cu-probe.mjs --runs 5        repetições por medição (p95 sai daí)
//   node scripts/cu-probe.mjs --frozen        congela o TextEdit (SIGSTOP) e mede o timeout
//   node scripts/cu-probe.mjs --json          saída em JSON (para colar no doc)
//
// Permissões: quem roda a probe é o terminal (ou o app que abriu o terminal).
// Para medir AX e captura, conceda Acessibilidade e Gravação de Tela a ele.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.error('A probe da Fase 0 só roda no macOS.')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(here, '..', 'electron', 'lib', 'computer', 'bridges', 'macos.js')
const args = process.argv.slice(2)
const RUNS = Number(args[args.indexOf('--runs') + 1]) || 3
const JSON_OUT = args.includes('--json')
const FROZEN = args.includes('--frozen')

// Os mesmos limites que o doc fixa como critério de aprovação.
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

// 1. Permissões e custo fixo de uma invocação
const perms = await bridge('perms')
report.permissions = perms.ok ? perms.result : perms.error
report.spawnMs = perms.ms
check('Acessibilidade concedida ao processo que roda a probe', perms.ok && perms.result.accessibility, perms.ok ? '' : perms.error?.message)

// 2. Lista de janelas (CGWindowList + NSWorkspace)
const listTimes = []
let snapshot = null
for (let i = 0; i < RUNS; i++) {
  const r = await bridge('apps')
  listTimes.push(r.ms)
  if (r.ok) snapshot = r.result
}
report.appsP95Ms = p95(listTimes)
report.windowTitlesVisible = Boolean(snapshot?.windows.some((w) => w.title))
check('Lista de apps e janelas', Boolean(snapshot), `p95 ${report.appsP95Ms} ms`)

// 3. Árvore AX e captura por app aberto
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
    report.apps.push({ ...entry, note: 'sem janela visível' })
    continue
  }
  for (const enhance of probe.kind === 'chromium' ? [false, true] : [false]) {
    const times = []
    let last = null
    for (let i = 0; i < RUNS; i++) {
      // Como o app: só a primeira leitura com a flag espera o Chromium montar a árvore.
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
    check(`Árvore ${a.label}`, false, a.tree.error.message)
    continue
  }
  if (a.kind === 'native') {
    check(`Observe ${a.label} p95 < ${CRITERIA.observeP95Ms} ms`, a.tree.p95Ms < CRITERIA.observeP95Ms, `${a.tree.p95Ms} ms, ${a.tree.nodes} nós`)
  } else {
    const plain = a.tree.nodes
    const rich = a.treeEnhanced?.nodes ?? 0
    check(`Árvore ${a.label} não vazia com a flag de acessibilidade`, rich > 20, `${plain} nós sem flag → ${rich} com flag`)
  }
  if (a.capture) {
    check(
      `Captura ${a.label} p95 < ${CRITERIA.captureP95Ms} ms`,
      Boolean(a.capture.p95Ms && a.capture.p95Ms < CRITERIA.captureP95Ms),
      a.capture.error ?? `${a.capture.p95Ms} ms, ${a.capture.kb} KB`,
    )
  }
}

// 4. App congelado: o timeout de mensageria tem que segurar a observação
if (FROZEN) {
  const textEdit = report.apps.find((a) => a.bundleId === 'com.apple.TextEdit' && a.windowId)
  if (!textEdit) {
    check('Timeout com app congelado', false, 'abra o TextEdit com uma janela para este teste')
  } else {
    const win = snapshot.windows.find((w) => w.id === textEdit.windowId)
    process.kill(textEdit.pid, 'SIGSTOP')
    try {
      const r = await bridge('tree', { pid: textEdit.pid, window: { frame: win.frame }, maxNodes: 250 }, 20_000)
      report.frozen = { ms: r.ms, ok: r.ok, truncated: r.result?.truncated ?? null, error: r.error ?? null }
      check(`App congelado responde em < ${CRITERIA.frozenMs} ms`, r.ms < CRITERIA.frozenMs, `${r.ms} ms (${r.ok ? r.result.truncated ?? 'completo' : r.error.code})`)
    } finally {
      process.kill(textEdit.pid, 'SIGCONT')
    }
  }
}

// 5. Processo quente: o quanto do tempo é só subir o osascript
const warmStart = Date.now()
await new Promise((resolve) => {
  const child = spawn('osascript', ['-l', 'JavaScript', '-e', 'function run() { return "1" }'])
  child.on('close', resolve)
})
report.coldSpawnMs = Date.now() - warmStart

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`\nComputer Use — Fase 0 (${report.at}, Darwin ${report.macos}, ${RUNS} execuções)\n`)
  console.log(`Subir o osascript: ${report.coldSpawnMs} ms · invocação mínima da bridge: ${report.spawnMs} ms`)
  console.log(`Títulos de janela visíveis (Gravação de Tela): ${report.windowTitlesVisible ? 'sim' : 'não'}\n`)
  console.log('| App | Árvore p95 | Nós | Com flag | Captura p95 |')
  console.log('|---|---|---|---|---|')
  for (const a of report.apps) {
    if (!a.running) {
      console.log(`| ${a.label} | não está aberto | | | |`)
      continue
    }
    const tree = a.tree?.error ? a.tree.error.code : a.tree ? `${a.tree.p95Ms} ms` : a.note ?? '—'
    const nodes = a.tree?.nodes ?? '—'
    const rich = a.treeEnhanced ? (a.treeEnhanced.error ? a.treeEnhanced.error.code : `${a.treeEnhanced.nodes} nós`) : '—'
    const cap = a.capture ? (a.capture.error ? 'negada' : `${a.capture.p95Ms} ms (${a.capture.kb} KB)`) : '—'
    console.log(`| ${a.label} | ${tree} | ${nodes} | ${rich} | ${cap} |`)
  }
  console.log('\nCritérios:')
  for (const c of report.checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  console.log('')
}
