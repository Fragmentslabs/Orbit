#!/usr/bin/env node
// Stage 0 do Computer Use no Windows: mede o host ANTES de confiar nos números
// do plano (docs/computer-use-windows.md). Sobe o MESMO host persistente do app
// (electron/lib/computer/bridges/windows*) e roda os cenários contra os apps
// abertos. Não foi possível rodá-lo no Mac: este script existe para ser rodado
// num Windows, e o relatório que ele grava é o que fecha (ou reprova) o portão.
//
// Uso (PowerShell ou cmd, com os apps de teste abertos):
//   node scripts/cu-probe-win.mjs                    mede tudo que der com o que está aberto
//   node scripts/cu-probe-win.mjs --runs 5           repetições por medição
//   node scripts/cu-probe-win.mjs --apps notepad,chrome,calculator   só estes
//   node scripts/cu-probe-win.mjs --global           também testa o ponteiro global (MOVE O SEU MOUSE)
//   node scripts/cu-probe-win.mjs --out relatorio.json
//
// Antes de rodar, abra o que quiser medir (o Bloco de Notas o probe abre sozinho):
//   Chrome com uma página grande (~1500 nós de acessibilidade), o Explorer, um app
//   Electron (VS Code, Slack...), a Calculadora (UWP), um app WPF e o Excel. Para o
//   teste de app elevado, abra um Bloco de Notas "como administrador". Para o teste
//   de DPI, deixe o monitor principal em 150% e, se tiver, um segundo monitor.
//
// O terminal que roda o probe faz o papel da "janela da frente": os apps de teste
// ficam ATRÁS dele durante os testes de segundo plano.
//
// O probe escreve no Bloco de Notas que ele mesmo abre e na barra de endereço do
// navegador (e desfaz). Não aperta botões de apps que ele não conhece.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.error('O probe do Stage 0 só roda no Windows (o host usa UI Automation, DWM e GDI).')
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

// Os critérios do portão (docs/computer-use-windows.md → Stage 0).
const CRITERIA = { treeMs: 800, treeNodes: 1000, captureMs: 150, clickMs: 150 }

const report = { when: new Date().toISOString(), os: `${os.type()} ${os.release()}`, criteria: CRITERIA, env: {}, apps: {}, verdict: {} }

// ------------------------------------------------------------------ estatística

const sorted = (xs) => [...xs].sort((a, b) => a - b)
const median = (xs) => (xs.length ? sorted(xs)[Math.floor((xs.length - 1) / 2)] : null)
const p95 = (xs) => (xs.length ? sorted(xs)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)] : null)
const stats = (xs) => ({ n: xs.length, median: median(xs), p95: p95(xs), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log(...parts)
const pass = (ok) => (ok === null ? 'n/a ' : ok ? 'OK  ' : 'FALHA')

// ------------------------------------------------------------------ o host

/** Cliente do host: uma linha JSON por pedido, resposta casada por id. */
class Host {
  constructor(file) {
    this.pending = new Map()
    this.seq = 0
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true })
    this.stderr = ''
    this.child.stderr.on('data', (d) => (this.stderr += d.toString()))
    this.child.on('close', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`o host saiu (código ${code}): ${this.stderr.slice(-300)}`))
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
      else p.reject(Object.assign(new Error(msg.error?.message ?? 'erro do host'), { code: msg.error?.code }))
    })
  }

  call(op, args = {}, timeoutMs = 20000) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`${op} passou de ${timeoutMs} ms`), { code: 'timeout' }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
    })
  }

  /** Mede o tempo de parede de uma chamada. */
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
  // O app grava o .ps1 com BOM (o PowerShell 5.1 lê ANSI sem ele): o probe faz o mesmo.
  fs.writeFileSync(path.join(dir, 'host.ps1'), `﻿${ps1}`, 'utf8')
  fs.copyFileSync(path.join(BRIDGES, 'windows-host.cs'), path.join(dir, 'host.cs'))
  fs.copyFileSync(path.join(BRIDGES, 'windows-host-actions.cs'), path.join(dir, 'actions.cs'))
  return path.join(dir, 'host.ps1')
}

// ------------------------------------------------------------------ cenários

/** Texto da árvore: usado como "impressão digital" para saber se a ação mudou algo. */
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
  { id: 'notepad', label: 'Bloco de Notas (Win32/RichEdit ou Win11)', match: (a) => /^notepad\.exe$/i.test(a.exe) },
  { id: 'explorer', label: 'Explorer', match: (a) => /^explorer\.exe$/i.test(a.exe) },
  { id: 'chrome', label: 'Chrome (Chromium)', match: (a) => /^(chrome|msedge|brave)\.exe$/i.test(a.exe) },
  { id: 'electron', label: 'App Electron (VS Code, Slack...)', match: (a) => /^(code|slack|discord|teams|ms-teams|whatsapp|notion|obsidian)\.exe$/i.test(a.exe) },
  { id: 'calculator', label: 'Calculadora (UWP)', match: (a) => /^calculatorapp\.exe$/i.test(a.exe) || /calculator/i.test(a.bundleId ?? '') },
  { id: 'wpf', label: 'App WPF (--wpf <exe>)', match: (a) => Boolean(value('--wpf')) && a.exe?.toLowerCase() === value('--wpf').toLowerCase() },
  { id: 'excel', label: 'Excel', match: (a) => /^excel\.exe$/i.test(a.exe) },
]

async function probeApp(host, kind, app, windows, front) {
  const out = { app: { name: app.name, exe: app.exe, pid: app.pid, elevated: app.elevated }, checks: {} }
  const win = windows.find((w) => w.pid === app.pid)
  if (!win) return { ...out, skipped: 'sem janela visível' }
  if (app.elevated) {
    // UIPI: o Orbit comum não controla app elevado. O host deve ao menos dizer isso.
    out.checks.elevated = { detected: true, note: 'o app roda como administrador — as ações precisam ser recusadas com mensagem clara' }
    return out
  }
  const request = (extra = {}) => ({ pid: app.pid, window: { id: win.id, frame: win.frame, title: win.title }, maxNodes: 2000, enhance: true, enhanceWaitMs: 450, ...extra })

  // 1) Árvore: com CacheRequest (o host) e sem (varredura uma-propriedade-por-chamada).
  await host.call('tree', request()).catch(() => undefined) // aquece: o Chromium monta a árvore na primeira vez
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
    // O critério só vale para uma árvore de tamanho parecido com a do Chrome (~1500 nós).
    pass: tree.nodes.length >= CRITERIA.treeNodes ? median(cached) < CRITERIA.treeMs : null,
  }

  // 2) Captura: PrintWindow (o host) e o quanto a janela está coberta.
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

  // 3) Segundo plano: o terminal vai para a frente e o app fica ATRÁS dele.
  await host.call('activate', { pid: front.pid }).catch(() => undefined)
  await sleep(250)
  const background = {}
  const before = await host.call('foreground')

  // 3a) Texto (modo dirigido: ValuePattern / EM_REPLACESEL, sem teclado sintético).
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
      // Desfaz: devolve o valor original quando o campo aceita.
      await host.call('element', { ...elementArgs(request, app, win, node ?? textTarget), kind: 'setValue', value: original }).catch(() => undefined)
    } catch (e) {
      background.text = { arrived: false, error: `${e.code ?? ''} ${e.message}` }
    }
  } else {
    background.text = { arrived: null, note: 'nenhum campo de texto na árvore' }
  }

  // 3b) Clique por padrão da UIA: latência e efeito.
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
    background.press = { note: 'nenhum controle seguro (caixa de seleção, aba, item de lista) para apertar' }
  }

  // 3c) Experimento — mensagem de mouse postada (NÃO é usada pelo driver): chega?
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

  // 3d) Experimento — WM_CHAR postado no elemento com foco da thread: chega?
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

  // 3e) Rolagem pela UIA (ScrollPattern).
  try {
    const cx = win.frame[0] + Math.floor(win.frame[2] / 2)
    const cy = win.frame[1] + Math.floor(win.frame[3] / 2)
    const r = await host.call('scrollAx', { pid: app.pid, x: cx, y: cy, dx: 0, dy: -120 })
    background.scrollPattern = { done: r.done, reason: r.reason }
  } catch (e) {
    background.scrollPattern = { error: `${e.code ?? ''} ${e.message}` }
  }

  // 3f) Atalho em modo dirigido: deve recusar com mensagem clara (precisa do ponteiro global).
  try {
    await host.call('keys', { pid: app.pid, combos: [{ code: 0x41, flags: 2 }], mode: 'pid' })
    background.shortcutDirected = { refused: false, note: 'aceitou — inesperado' }
  } catch (e) {
    background.shortcutDirected = { refused: e.code === 'unavailable', code: e.code }
  }

  // 3g) Ponteiro global (só com --global; MOVE O MOUSE e traz o app para a frente).
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

/** Os argumentos de uma ação de elemento: ref + path + identidade (como o act.ts monta). */
function elementArgs(request, app, win, node) {
  return {
    pid: app.pid,
    window: { id: win.id, frame: win.frame, title: win.title },
    path: node.path,
    ref: node.ref,
    expect: { role: node.role, title: node.title },
  }
}

// ------------------------------------------------------------------ principal

async function main() {
  log('Probe do Stage 0 — Computer Use no Windows')
  log(`${report.os}, node ${process.version}\n`)

  // PowerShell: versão, Constrained Language Mode, elevação do próprio probe.
  const psInfo = await ps(
    "[pscustomobject]@{ version = $PSVersionTable.PSVersion.ToString(); mode = [string]$ExecutionContext.SessionState.LanguageMode; admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress",
  )
  report.env.powershell = psInfo ? JSON.parse(psInfo) : null
  log('PowerShell:', report.env.powershell ?? '(não respondeu)')
  if (report.env.powershell && report.env.powershell.mode !== 'FullLanguage') {
    log(`\nFALHA: o PowerShell está em ${report.env.powershell.mode}. O host precisa de Add-Type (AppLocker/WDAC bloqueia). O Orbit mostraria este motivo nas Preferências.`)
    report.verdict.constrainedLanguage = true
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(2)
  }

  // Partida do host (inclui o Add-Type).
  const file = writeHostFiles()
  const t0 = performance.now()
  const host = new Host(file)
  try {
    await host.call('ping', {}, 60000)
  } catch (e) {
    log(`\nFALHA ao subir o host: ${e.message}\n${host.stderr.slice(-600)}`)
    report.verdict.hostStarted = false
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    host.stop()
    process.exit(2)
  }
  report.env.hostStartMs = Math.round(performance.now() - t0)
  const warm = await host.timed('ping')
  report.env.pingMs = warm.ms
  log(`Host: partida ${report.env.hostStartMs} ms (Add-Type uma vez); ping já aquecido ${warm.ms} ms`)

  const perms = await host.call('perms')
  report.env.perms = perms
  for (const n of perms.notes ?? []) log(`  - ${n}`)

  // DPI e monitores.
  const displays = await host.call('displays')
  report.env.displays = displays.monitors
  log('\nMonitores:')
  for (const m of displays.monitors) log(`  ${m.primary ? '*' : ' '} ${m.frame[2]}x${m.frame[3]} px em (${m.frame[0]}, ${m.frame[1]}) — ${Math.round(m.scale * 100)}% (${m.dpi} dpi)`)
  report.verdict.dpi150 = displays.monitors.some((m) => Math.abs(m.scale - 1.5) < 0.01)
  report.verdict.multiMonitor = displays.monitors.length > 1
  if (!report.verdict.dpi150) log('  (nenhum monitor a 150%: o teste de DPI não vale — Configurações → Sistema → Vídeo → Escala)')
  if (!report.verdict.multiMonitor) log('  (um monitor só: o teste de dois monitores não vale)')

  // O terminal que roda o probe é a "janela da frente" dos testes de segundo plano.
  const front = await host.call('foreground')
  report.env.terminal = front
  log(`\nJanela da frente (este terminal): pid ${front.pid} "${front.title}"`)

  // Garante o Bloco de Notas (o probe o abre e testa o openApp de quebra).
  let snapshot = await host.call('apps')
  if (!snapshot.apps.some((a) => /^notepad\.exe$/i.test(a.exe)) && (!ONLY || ONLY.includes('notepad'))) {
    const t1 = performance.now()
    try {
      const opened = await host.call('openApp', { app: 'notepad' }, 40000)
      report.env.openApp = { ms: Math.round(performance.now() - t1), done: opened.done }
      log(`openApp("notepad"): ${opened.done} em ${report.env.openApp.ms} ms`)
    } catch (e) {
      report.env.openApp = { error: `${e.code ?? ''} ${e.message}` }
      log(`openApp("notepad") falhou: ${e.message}`)
    }
    snapshot = await host.call('apps')
  }

  const elevatedApps = snapshot.apps.filter((a) => a.elevated)
  report.env.elevatedApps = elevatedApps.map((a) => a.name)
  log(`\nApps elevados (administrador) detectados: ${elevatedApps.length ? elevatedApps.map((a) => a.name).join(', ') : 'nenhum (abra um Bloco de Notas como administrador para testar o UIPI)'}`)

  for (const kind of KINDS) {
    if (ONLY && !ONLY.includes(kind.id)) continue
    const app = snapshot.apps.find((a) => kind.match(a) && !a.elevated) ?? snapshot.apps.find((a) => kind.match(a))
    if (!app) {
      report.apps[kind.id] = { skipped: 'não está aberto' }
      log(`\n== ${kind.label}: não está aberto — pulado`)
      continue
    }
    log(`\n== ${kind.label}: ${app.name} (${app.exe}, pid ${app.pid})`)
    try {
      const r = await probeApp(host, kind, app, snapshot.windows, front)
      report.apps[kind.id] = r
      printApp(r)
    } catch (e) {
      report.apps[kind.id] = { error: `${e.code ?? ''} ${e.message}` }
      log(`  ERRO: ${e.message}`)
    }
  }

  // Quem estava na frente volta a ficar.
  await host.call('activate', { pid: front.pid }).catch(() => undefined)

  // Veredito contra o portão.
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

  log('\n=== Veredito do portão ===')
  log(`  árvore (CacheRequest) < ${CRITERIA.treeMs} ms com ≥ ${CRITERIA.treeNodes} nós : ${pass(report.verdict.tree)}`)
  log(`  captura < ${CRITERIA.captureMs} ms                                  : ${pass(report.verdict.capture)}`)
  log(`  clique por elemento < ${CRITERIA.clickMs} ms                         : ${pass(report.verdict.click)}`)
  log('  segundo plano por tipo de app (texto e clique pela UIA / mensagens postadas):')
  for (const [id, row] of Object.entries(report.verdict.backgroundMatrix)) {
    log(`    ${id.padEnd(11)} texto=${fmt(row.textByUia)} clique=${fmt(row.pressByUia)} | mouse-msg=${fmt(row.mouseMessage)} char-msg=${fmt(row.charMessage)} rolagem=${row.scrollPattern ?? 'n/a'}`)
  }
  log('\nManual (o Node não vê o desktopCapturer do Electron): grave uma janela COBERTA com cu_record_start no Orbit,')
  log('confira que o vídeo mostra o app e não o que está por cima, e anote se o Windows desenhou a borda amarela.')

  host.stop()
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  log(`\nRelatório: ${OUT}`)
}

const fmt = (v) => (v === null || v === undefined ? 'n/a' : v ? 'sim' : 'NÃO')

function printApp(r) {
  if (r.skipped) return log(`  pulado: ${r.skipped}`)
  const c = r.checks
  if (c.elevated) return log(`  ELEVADO: ${c.elevated.note}`)
  const t = c.tree
  log(`  árvore: ${t.nodes} nós${t.truncated ? ` (parou: ${t.truncated})` : ''}; com CacheRequest mediana ${t.withCache.median} ms (p95 ${t.withCache.p95}); sem: ${t.withoutCache.median ?? '?'} ms; ${pass(t.pass)}${t.url ? `; URL ${t.url}` : ''}`)
  const k = c.capture
  log(`  captura: mediana ${k.median ?? '?'} ms (p95 ${k.p95 ?? '?'}) por ${k.methods.join('/') || 'nenhuma'}${k.coveredDuringTest ? ', janela COBERTA durante o teste' : ''}; ${pass(k.pass)}${c.captureError ? `; ERRO ${c.captureError.message}` : ''}`)
  const b = c.background
  if (!b) return
  if (b.text) log(`  texto em segundo plano: ${b.text.arrived === null ? b.text.note : `${b.text.arrived ? 'chegou' : 'NÃO chegou'}${b.text.stoleFocus ? ', ROUBOU O FOCO' : ''}${b.text.error ? ` (${b.text.error})` : ''}`}`)
  if (b.press) log(`  clique pela UIA: ${b.press.ms !== undefined ? `${b.press.ms} ms, ${b.press.done}/${b.press.action}, ${b.press.changedTree ? 'mudou a tela' : 'SEM efeito visível'}${b.press.stoleFocus ? ', ROUBOU O FOCO' : ''}; ${pass(b.press.pass)}` : (b.press.note ?? b.press.error)}`)
  if (b.postedMouse) log(`  [experimento] mouse por mensagem: ${b.postedMouse.sent === false ? `não enviado (${b.postedMouse.reason})` : b.postedMouse.error ?? `${b.postedMouse.hadEffect ? 'TEVE efeito' : 'sem efeito'} (${b.postedMouse.class})`}`)
  if (b.postedChars) log(`  [experimento] WM_CHAR: ${b.postedChars.error ?? `${b.postedChars.arrived ? 'chegou' : 'não chegou'} (${b.postedChars.class})`}`)
  if (b.scrollPattern) log(`  rolagem (ScrollPattern): ${b.scrollPattern.done ?? b.scrollPattern.reason ?? b.scrollPattern.error}`)
  if (b.shortcutDirected) log(`  atalho em modo dirigido: ${b.shortcutDirected.refused ? 'recusado com mensagem (esperado)' : 'NÃO recusou'}`)
  if (b.globalPointer) log(`  ponteiro global: ${b.globalPointer.error ?? `${b.globalPointer.ms} ms, cursor ${b.globalPointer.cursorMoved ? 'moveu' : 'NÃO moveu'} para ${b.globalPointer.landedAt} (queria ${b.globalPointer.wanted})`}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
