#!/usr/bin/env node
// Stage 0 of Computer Use on Windows: measures the host BEFORE trusting the numbers
// of the plan (docs/computer-use-windows.md). Starts the SAME persistent host as the app
// (electron/lib/computer/bridges/windows*) and runs the scenarios against the open
// apps. It could not be run on the Mac: this script exists to be run
// on a Windows machine, and the report it writes is what closes (or rejects) the gate.
//
// Usage (PowerShell or cmd, with the test apps open):
//   node scripts/cu-probe-win.mjs                    measures everything possible with what is open
//   node scripts/cu-probe-win.mjs --runs 5           repetitions per measurement
//   node scripts/cu-probe-win.mjs --apps notepad,chrome,calculator   only these
//   node scripts/cu-probe-win.mjs --global           also tests the global pointer (MOVES YOUR MOUSE)
//   node scripts/cu-probe-win.mjs --out report.json
//
// Before running, open what you want to measure (the probe opens Notepad on its own):
//   Chrome with a large page (~1500 accessibility nodes), Explorer, an
//   Electron app (VS Code, Slack...), Calculator (UWP), a WPF app and Excel. For the
//   elevated app test, open Notepad "as administrator". For the
//   DPI test, set the main monitor to 150% and, if you have one, a second monitor.
//
// The terminal that runs the probe plays the role of the "front window": the test apps
// stay BEHIND it during the background tests.
//
// The probe writes in the Notepad it opens itself and in the address bar of the
// browser (and undoes it). It does not press buttons of apps it does not know.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.error('The Stage 0 probe only runs on Windows (the host uses UI Automation, DWM and GDI).')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const BRIDGES = path.join(here, '..', 'electron', 'lib', 'computer', 'bridges')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const RUNS = Number(value('--runs')) || 5
const GLOBAL = flag('--global')
const OUT = value('--out') ?? path.join(process.cwd(), 'cu-probe-win-report.json')
const ONLY = value('--apps')?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

// The gate criteria (docs/computer-use-windows.md → Stage 0).
const CRITERIA = { treeMs: 800, treeNodes: 1000, captureMs: 150, clickMs: 150 }

const report = { when: new Date().toISOString(), os: `${os.type()} ${os.release()}`, criteria: CRITERIA, env: {}, apps: {}, verdict: {} }

// ------------------------------------------------------------------ statistics

const sorted = (xs) => [...xs].sort((a, b) => a - b)
const median = (xs) => (xs.length ? sorted(xs)[Math.floor((xs.length - 1) / 2)] : null)
const p95 = (xs) => (xs.length ? sorted(xs)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)] : null)
const stats = (xs) => ({ n: xs.length, median: median(xs), p95: p95(xs), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log(...parts)
const pass = (ok) => (ok === null ? 'n/a  ' : ok ? 'OK   ' : 'FAIL ')

// ------------------------------------------------------------------ the host

/** Client of the host: one JSON line per request, response matched by id. */
class Host {
  constructor(file) {
    this.pending = new Map()
    this.seq = 0
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true })
    this.stderr = ''
    this.child.stderr.on('data', (d) => (this.stderr += d.toString()))
    this.child.on('close', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`the host exited (code ${code}): ${this.stderr.slice(-300)}`))
      this.pending.clear()
    })
    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(Object.assign(new Error(msg.error?.message ?? 'host error'), { code: msg.error?.code }))
    })
  }

  call(op, args = {}, timeoutMs = 20000) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`${op} took more than ${timeoutMs} ms`), { code: 'timeout' }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
    })
  }

  /** Measures the wall time of a call. */
  async timed(op, args, timeoutMs) {
    const t0 = performance.now()
    const result = await this.call(op, args, timeoutMs)
    return { result, ms: Math.round(performance.now() - t0) }
  }

  stop() {
    this.child.kill()
  }
}

function ps(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 }, (err, stdout) => resolve(err ? null : stdout.trim()))
  })
}

function writeHostFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-probe-win-'))
  const ps1 = fs.readFileSync(path.join(BRIDGES, 'windows.ps1'), 'utf8')
  // The app writes the .ps1 with BOM (PowerShell 5.1 reads it as ANSI without it): the probe does the same.
  fs.writeFileSync(path.join(dir, 'host.ps1'), `﻿${ps1}`, 'utf8')
  fs.copyFileSync(path.join(BRIDGES, 'windows-host.cs'), path.join(dir, 'host.cs'))
  fs.copyFileSync(path.join(BRIDGES, 'windows-host-actions.cs'), path.join(dir, 'actions.cs'))
  return path.join(dir, 'host.ps1')
}

// ------------------------------------------------------------------ scenarios

/** Text of the tree: used as a "fingerprint" to know whether the action changed something. */
function digest(tree) {
  return tree.nodes.map((n) => `${n.role}|${n.title ?? ''}|${(n.value ?? '').slice(0, 60)}|${n.selected ? 1 : 0}|${n.enabled ? 1 : 0}`).join('\n')
}

const TEXT_ROLES = new Set(['Edit', 'Document', 'ComboBox'])
const SAFE_PRESS_ROLES = new Set(['CheckBox', 'RadioButton', 'TabItem', 'ListItem', 'TreeItem'])

function findTextTarget(tree) {
  return tree.nodes.find((n) => TEXT_ROLES.has(n.role) && !n.secure && n.enabled && n.frame && n.frame[2] > 30 && n.frame[3] > 10 && n.value !== undefined)
}
function findPressTarget(tree) {
  return tree.nodes.find((n) => SAFE_PRESS_ROLES.has(n.role) && n.enabled && n.frame && n.frame[2] > 0 && (n.actions.includes('AXPress') || n.actions.includes('AXPick')))
}

const KINDS = [
  { id: 'notepad', label: 'Notepad (Win32/RichEdit or Win11)', match: (a) => /^notepad\.exe$/i.test(a.exe) },
  { id: 'explorer', label: 'Explorer', match: (a) => /^explorer\.exe$/i.test(a.exe) },
  { id: 'chrome', label: 'Chrome (Chromium)', match: (a) => /^(chrome|msedge|brave)\.exe$/i.test(a.exe) },
  { id: 'electron', label: 'Electron app (VS Code, Slack...)', match: (a) => /^(code|slack|discord|teams|ms-teams|whatsapp|notion|obsidian)\.exe$/i.test(a.exe) },
  { id: 'calculator', label: 'Calculator (UWP)', match: (a) => /^calculatorapp\.exe$/i.test(a.exe) || /calculator/i.test(a.bundleId ?? '') },
  { id: 'wpf', label: 'WPF app (--wpf <exe>)', match: (a) => Boolean(value('--wpf')) && a.exe?.toLowerCase() === value('--wpf').toLowerCase() },
  { id: 'excel', label: 'Excel', match: (a) => /^excel\.exe$/i.test(a.exe) },
]

async function probeApp(host, kind, app, windows, front) {
  const out = { app: { name: app.name, exe: app.exe, pid: app.pid, elevated: app.elevated }, checks: {} }
  const win = windows.find((w) => w.pid === app.pid)
  if (!win) return { ...out, skipped: 'no visible window' }
  if (app.elevated) {
    // UIPI: an ordinary Orbit does not control an elevated app. The host must at least say so.
    out.checks.elevated = { detected: true, note: 'the app runs as administrator — actions must be refused with a clear message' }
    return out
  }
  const request = (extra = {}) => ({ pid: app.pid, window: { id: win.id, frame: win.frame, title: win.title }, maxNodes: 2000, enhance: true, enhanceWaitMs: 450, ...extra })

  // 1) Tree: with CacheRequest (the host) and without (one-property-per-call scan).
  await host.call('tree', request()).catch(() => undefined) // warms it up: Chromium builds the tree on the first time
  const cached = []
  let tree = null
  for (let i = 0; i < RUNS; i++) {
    const r = await host.timed('tree', request({ enhanceWaitMs: 0 }), 30000)
    cached.push(r.ms)
    tree = r.result
  }
  const uncached = []
  for (let i = 0; i < Math.min(RUNS, 3); i++) {
    const r = await host.timed('treeBench', { window: { id: win.id }, maxNodes: 2000 }, 60000).catch(() => null)
    if (r) uncached.push(r.ms)
  }
  out.checks.tree = {
    nodes: tree.nodes.length,
    truncated: tree.truncated,
    withCache: stats(cached),
    withoutCache: stats(uncached),
    url: tree.nodes.find((n) => n.url)?.url ?? null,
    // The criterion is only worth for a tree of a size similar to Chrome's (~1500 nodes).
    pass: tree.nodes.length >= CRITERIA.treeNodes ? median(cached) < CRITERIA.treeMs : null,
  }

  // 2) Capture: PrintWindow (the host) and how much the window is covered.
  const captures = []
  const methods = new Set()
  let covered = false
  const file = path.join(os.tmpdir(), `cu-probe-${process.pid}-${win.id}.png`)
  for (let i = 0; i < RUNS; i++) {
    try {
      const r = await host.timed('capture', { windowId: win.id, file }, 20000)
      captures.push(r.ms)
      methods.add(r.result.method)
      covered ||= Boolean(r.result.covered)
      out.checks.captureSize = { width: r.result.width, height: r.result.height, bytes: fs.statSync(file).size, frame: win.frame }
    } catch (e) {
      out.checks.captureError = { code: e.code, message: e.message }
      break
    }
  }
  fs.rmSync(file, { force: true })
  out.checks.capture = { ...stats(captures), methods: [...methods], coveredDuringTest: covered, pass: captures.length ? median(captures) < CRITERIA.captureMs : false }

  // 3) Background: the terminal goes to the front and the app stays BEHIND it.
  await host.call('activate', { pid: front.pid }).catch(() => undefined)
  await sleep(250)
  const background = {}
  const before = await host.call('foreground')

  // 3a) Text (directed mode: ValuePattern / EM_REPLACESEL, without synthetic keyboard).
  const textTarget = findTextTarget(tree)
  if (textTarget) {
    const marker = `orbit-${Date.now() % 100000}`
    const original = textTarget.value ?? ''
    try {
      await host.call('element', { ...elementArgs(request, app, win, textTarget), kind: 'focus' })
      await host.call('keys', { pid: app.pid, text: marker, mode: 'pid' })
      await sleep(250)
      const after = await host.call('tree', request({ enhanceWaitMs: 0, maxNodes: 2000 }))
      const node = after.nodes.find((n) => n.ref === textTarget.ref) ?? after.nodes.find((n) => n.role === textTarget.role && n.title === textTarget.title)
      const arrived = Boolean(node?.value?.includes(marker))
      const fg = await host.call('foreground')
      background.text = { arrived, stoleFocus: fg.window !== before.window, role: textTarget.role }
      // Undoes it: gives the original value back when the field accepts it.
      await host.call('element', { ...elementArgs(request, app, win, node ?? textTarget), kind: 'setValue', value: original }).catch(() => undefined)
    } catch (e) {
      background.text = { arrived: false, error: `${e.code ?? ''} ${e.message}` }
    }
  } else {
    background.text = { arrived: null, note: 'no text field in the tree' }
  }

  // 3b) Click by UIA default pattern: latency and effect.
  const pressTarget = findPressTarget(tree)
  if (pressTarget) {
    try {
      const d0 = digest(await host.call('tree', request({ enhanceWaitMs: 0 })))
      const r = await host.timed('element', { ...elementArgs(request, app, win, pressTarget), kind: 'press', actions: ['AXPress', 'AXConfirm', 'AXOpen', 'AXPick'] })
      await sleep(250)
      const d1 = digest(await host.call('tree', request({ enhanceWaitMs: 0 })))
      const fg = await host.call('foreground')
      background.press = { ms: r.ms, done: r.result.done, action: r.result.action, changedTree: d0 !== d1, stoleFocus: fg.window !== before.window, role: pressTarget.role, pass: r.ms < CRITERIA.clickMs }
      if (d0 !== d1) await host.call('element', { ...elementArgs(request, app, win, pressTarget), kind: 'press', actions: ['AXPress', 'AXPick'] }).catch(() => undefined)
    } catch (e) {
      background.press = { error: `${e.code ?? ''} ${e.message}` }
    }
  } else {
    background.press = { note: 'no safe control (check box, tab, list item) to press' }
  }

  // 3c) Experiment — posted mouse message (NOT used by the driver): does it arrive?
  if (pressTarget?.frame) {
    try {
      const cx = pressTarget.frame[0] + Math.floor(pressTarget.frame[2] / 2)
      const cy = pressTarget.frame[1] + Math.floor(pressTarget.frame[3] / 2)
      const d0 = digest(await host.call('tree', request({ enhanceWaitMs: 0 })))
      const sent = await host.call('postMouse', { windowId: win.id, x: cx, y: cy, button: 'left' })
      await sleep(300)
      const d1 = digest(await host.call('tree', request({ enhanceWaitMs: 0 })))
      background.postedMouse = { sent: sent.sent, reason: sent.reason, class: sent.class, hadEffect: d0 !== d1 }
      if (d0 !== d1) await host.call('element', { ...elementArgs(request, app, win, pressTarget), kind: 'press', actions: ['AXPress', 'AXPick'] }).catch(() => undefined)
    } catch (e) {
      background.postedMouse = { error: `${e.code ?? ''} ${e.message}` }
    }
  }

  // 3d) Experiment — WM_CHAR posted to the focused element of the thread: does it arrive?
  if (textTarget) {
    try {
      const marker = `w${Date.now() % 10000}`
      await host.call('element', { ...elementArgs(request, app, win, textTarget), kind: 'focus' })
      const sent = await host.call('postChars', { pid: app.pid, windowId: win.id, text: marker })
      await sleep(300)
      const after = await host.call('tree', request({ enhanceWaitMs: 0 }))
      const node = after.nodes.find((n) => n.ref === textTarget.ref) ?? after.nodes.find((n) => n.role === textTarget.role && n.title === textTarget.title)
      background.postedChars = { class: sent.class, arrived: Boolean(node?.value?.includes(marker)) }
      await host.call('element', { ...elementArgs(request, app, win, node ?? textTarget), kind: 'setValue', value: textTarget.value ?? '' }).catch(() => undefined)
    } catch (e) {
      background.postedChars = { error: `${e.code ?? ''} ${e.message}` }
    }
  }

  // 3e) Scrolling through UIA (ScrollPattern).
  try {
    const cx = win.frame[0] + Math.floor(win.frame[2] / 2)
    const cy = win.frame[1] + Math.floor(win.frame[3] / 2)
    const r = await host.call('scrollAx', { pid: app.pid, x: cx, y: cy, dx: 0, dy: -120 })
    background.scrollPattern = { done: r.done, reason: r.reason }
  } catch (e) {
    background.scrollPattern = { error: `${e.code ?? ''} ${e.message}` }
  }

  // 3f) Shortcut in directed mode: it must refuse with a clear message (it needs the global pointer).
  try {
    await host.call('keys', { pid: app.pid, combos: [{ code: 0x41, flags: 2 }], mode: 'pid' })
    background.shortcutDirected = { refused: false, note: 'accepted — unexpected' }
  } catch (e) {
    background.shortcutDirected = { refused: e.code === 'unavailable', code: e.code }
  }

  // 3g) Global pointer (only with --global; MOVES THE MOUSE and brings the app to the front).
  if (GLOBAL && pressTarget?.frame) {
    try {
      const c0 = await host.call('cursor')
      const cx = pressTarget.frame[0] + Math.floor(pressTarget.frame[2] / 2)
      const cy = pressTarget.frame[1] + Math.floor(pressTarget.frame[3] / 2)
      const r = await host.timed('mouse', { pid: app.pid, windowId: win.id, x: cx, y: cy, kind: 'move', mode: 'global' })
      const c1 = await host.call('cursor')
      background.globalPointer = { ms: r.ms, cursorMoved: c0.x !== c1.x || c0.y !== c1.y, landedAt: [c1.x, c1.y], wanted: [cx, cy] }
    } catch (e) {
      background.globalPointer = { error: `${e.code ?? ''} ${e.message}` }
    }
  }

  out.checks.background = background
  return out
}

/** The arguments of an element action: ref + path + identity (as act.ts assembles it). */
function elementArgs(request, app, win, node) {
  return {
    pid: app.pid,
    window: { id: win.id, frame: win.frame, title: win.title },
    path: node.path,
    ref: node.ref,
    expect: { role: node.role, title: node.title },
  }
}

// ------------------------------------------------------------------ main

async function main() {
  log('Stage 0 probe — Computer Use on Windows')
  log(`${report.os}, node ${process.version}\n`)

  // PowerShell: version, Constrained Language Mode, elevation of the probe itself.
  const psInfo = await ps(
    "[pscustomobject]@{ version = $PSVersionTable.PSVersion.ToString(); mode = [string]$ExecutionContext.SessionState.LanguageMode; admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress",
  )
  report.env.powershell = psInfo ? JSON.parse(psInfo) : null
  log('PowerShell:', report.env.powershell ?? '(did not answer)')
  if (report.env.powershell && report.env.powershell.mode !== 'FullLanguage') {
    log(`\nFAIL: PowerShell is in ${report.env.powershell.mode}. The host needs Add-Type (AppLocker/WDAC blocks it). Orbit would show this reason in the Preferences.`)
    report.verdict.constrainedLanguage = true
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(2)
  }

  // Start of the host (it includes the Add-Type).
  const file = writeHostFiles()
  const t0 = performance.now()
  const host = new Host(file)
  try {
    await host.call('ping', {}, 60000)
  } catch (e) {
    log(`\nFAILED to start the host: ${e.message}\n${host.stderr.slice(-600)}`)
    report.verdict.hostStarted = false
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    host.stop()
    process.exit(2)
  }
  report.env.hostStartMs = Math.round(performance.now() - t0)
  const warm = await host.timed('ping')
  report.env.pingMs = warm.ms
  log(`Host: start-up ${report.env.hostStartMs} ms (Add-Type once); warm ping ${warm.ms} ms`)

  const perms = await host.call('perms')
  report.env.perms = perms
  for (const n of perms.notes ?? []) log(`  - ${n}`)

  // DPI and monitors.
  const displays = await host.call('displays')
  report.env.displays = displays.monitors
  log('\nMonitors:')
  for (const m of displays.monitors) log(`  ${m.primary ? '*' : ' '} ${m.frame[2]}x${m.frame[3]} px at (${m.frame[0]}, ${m.frame[1]}) — ${Math.round(m.scale * 100)}% (${m.dpi} dpi)`)
  report.verdict.dpi150 = displays.monitors.some((m) => Math.abs(m.scale - 1.5) < 0.01)
  report.verdict.multiMonitor = displays.monitors.length > 1
  if (!report.verdict.dpi150) log('  (no monitor at 150%: the DPI test does not apply — Settings → System → Display → Scale)')
  if (!report.verdict.multiMonitor) log('  (a single monitor: the two-monitor test does not apply)')

  // The terminal that runs the probe is the "front window" of the background tests.
  const front = await host.call('foreground')
  report.env.terminal = front
  log(`\nFront window (this terminal): pid ${front.pid} "${front.title}"`)

  // Guarantees Notepad (the probe opens it and tests openApp on the way).
  let snapshot = await host.call('apps')
  if (!snapshot.apps.some((a) => /^notepad\.exe$/i.test(a.exe)) && (!ONLY || ONLY.includes('notepad'))) {
    const t1 = performance.now()
    try {
      const opened = await host.call('openApp', { app: 'notepad' }, 40000)
      report.env.openApp = { ms: Math.round(performance.now() - t1), done: opened.done }
      log(`openApp("notepad"): ${opened.done} in ${report.env.openApp.ms} ms`)
    } catch (e) {
      report.env.openApp = { error: `${e.code ?? ''} ${e.message}` }
      log(`openApp("notepad") failed: ${e.message}`)
    }
    snapshot = await host.call('apps')
  }

  const elevatedApps = snapshot.apps.filter((a) => a.elevated)
  report.env.elevatedApps = elevatedApps.map((a) => a.name)
  log(`\nElevated apps (administrator) detected: ${elevatedApps.length ? elevatedApps.map((a) => a.name).join(', ') : 'none (open Notepad as administrator to test the UIPI)'}`)

  for (const kind of KINDS) {
    if (ONLY && !ONLY.includes(kind.id)) continue
    const app = snapshot.apps.find((a) => kind.match(a) && !a.elevated) ?? snapshot.apps.find((a) => kind.match(a))
    if (!app) {
      report.apps[kind.id] = { skipped: 'not open' }
      log(`\n== ${kind.label}: not open — skipped`)
      continue
    }
    log(`\n== ${kind.label}: ${app.name} (${app.exe}, pid ${app.pid})`)
    try {
      const r = await probeApp(host, kind, app, snapshot.windows, front)
      report.apps[kind.id] = r
      printApp(r)
    } catch (e) {
      report.apps[kind.id] = { error: `${e.code ?? ''} ${e.message}` }
      log(`  ERROR: ${e.message}`)
    }
  }

  // Whoever was in front comes back to the front.
  await host.call('activate', { pid: front.pid }).catch(() => undefined)

  // Verdict against the gate.
  const apps = Object.values(report.apps).filter((a) => a.checks)
  const trees = apps.map((a) => a.checks.tree).filter((t) => t && t.pass !== null)
  const captures = apps.map((a) => a.checks.capture).filter(Boolean)
  const presses = apps.map((a) => a.checks.background?.press).filter((p) => p && p.ms !== undefined)
  report.verdict.tree = trees.length ? trees.every((t) => t.pass) : null
  report.verdict.capture = captures.length ? captures.every((c) => c.pass) : null
  report.verdict.click = presses.length ? presses.every((p) => p.pass) : null
  report.verdict.backgroundMatrix = Object.fromEntries(
    Object.entries(report.apps)
      .filter(([, a]) => a.checks?.background)
      .map(([id, a]) => {
        const b = a.checks.background
        return [id, { textByUia: b.text?.arrived ?? null, pressByUia: b.press?.changedTree ?? null, mouseMessage: b.postedMouse?.hadEffect ?? null, charMessage: b.postedChars?.arrived ?? null, scrollPattern: b.scrollPattern?.done ?? null }]
      }),
  )

  log('\n=== Gate verdict ===')
  log(`  tree (CacheRequest) < ${CRITERIA.treeMs} ms with ≥ ${CRITERIA.treeNodes} nodes : ${pass(report.verdict.tree)}`)
  log(`  capture < ${CRITERIA.captureMs} ms                                  : ${pass(report.verdict.capture)}`)
  log(`  click per element < ${CRITERIA.clickMs} ms                         : ${pass(report.verdict.click)}`)
  log('  background per app type (text and click by UIA / posted messages):')
  for (const [id, row] of Object.entries(report.verdict.backgroundMatrix)) {
    log(`    ${id.padEnd(11)} text=${fmt(row.textByUia)} click=${fmt(row.pressByUia)} | mouse-msg=${fmt(row.mouseMessage)} char-msg=${fmt(row.charMessage)} scroll=${row.scrollPattern ?? 'n/a'}`)
  }
  log('\nManual (Node cannot see the Electron desktopCapturer): record a COVERED window with cu_record_start in Orbit,')
  log('check that the video shows the app and not what is on top of it, and note whether Windows drew the yellow border.')

  host.stop()
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  log(`\nReport: ${OUT}`)
}

const fmt = (v) => (v === null || v === undefined ? 'n/a' : v ? 'yes' : 'NO')

function printApp(r) {
  if (r.skipped) return log(`  skipped: ${r.skipped}`)
  const c = r.checks
  if (c.elevated) return log(`  ELEVATED: ${c.elevated.note}`)
  const t = c.tree
  log(`  tree: ${t.nodes} nodes${t.truncated ? ` (stopped: ${t.truncated})` : ''}; with CacheRequest median ${t.withCache.median} ms (p95 ${t.withCache.p95}); without: ${t.withoutCache.median ?? '?'} ms; ${pass(t.pass)}${t.url ? `; URL ${t.url}` : ''}`)
  const k = c.capture
  log(`  capture: median ${k.median ?? '?'} ms (p95 ${k.p95 ?? '?'}) by ${k.methods.join('/') || 'none'}${k.coveredDuringTest ? ', window COVERED during the test' : ''}; ${pass(k.pass)}${c.captureError ? `; ERROR ${c.captureError.message}` : ''}`)
  const b = c.background
  if (!b) return
  if (b.text) log(`  text in the background: ${b.text.arrived === null ? b.text.note : `${b.text.arrived ? 'arrived' : 'did NOT arrive'}${b.text.stoleFocus ? ', STOLE THE FOCUS' : ''}${b.text.error ? ` (${b.text.error})` : ''}`}`)
  if (b.press) log(`  click by UIA: ${b.press.ms !== undefined ? `${b.press.ms} ms, ${b.press.done}/${b.press.action}, ${b.press.changedTree ? 'changed the screen' : 'NO visible effect'}${b.press.stoleFocus ? ', STOLE THE FOCUS' : ''}; ${pass(b.press.pass)}` : (b.press.note ?? b.press.error)}`)
  if (b.postedMouse) log(`  [experiment] mouse by message: ${b.postedMouse.sent === false ? `not sent (${b.postedMouse.reason})` : b.postedMouse.error ?? `${b.postedMouse.hadEffect ? 'HAD effect' : 'no effect'} (${b.postedMouse.class})`}`)
  if (b.postedChars) log(`  [experiment] WM_CHAR: ${b.postedChars.error ?? `${b.postedChars.arrived ? 'arrived' : 'did not arrive'} (${b.postedChars.class})`}`)
  if (b.scrollPattern) log(`  scroll (ScrollPattern): ${b.scrollPattern.done ?? b.scrollPattern.reason ?? b.scrollPattern.error}`)
  if (b.shortcutDirected) log(`  shortcut in directed mode: ${b.shortcutDirected.refused ? 'refused with a message (expected)' : 'did NOT refuse'}`)
  if (b.globalPointer) log(`  global pointer: ${b.globalPointer.error ?? `${b.globalPointer.ms} ms, cursor ${b.globalPointer.cursorMoved ? 'moved' : 'did NOT move'} to ${b.globalPointer.landedAt} (wanted ${b.globalPointer.wanted})`}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
