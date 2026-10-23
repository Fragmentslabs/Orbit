#!/usr/bin/env node
// Smoke manual do Computer Use, sem LLM: roda a bridge do app contra um
// TextEdit de verdade e confere o laço inteiro — listar, ler a árvore,
// digitar, ler de volta, clicar por acessibilidade e capturar.
//
// Uso:
//   node scripts/cu-smoke.mjs           só leitura (lista, árvore, captura)
//   node scripts/cu-smoke.mjs --act     também digita num documento novo do TextEdit
//   node scripts/cu-smoke.mjs --global  ações pelo ponteiro real (move o cursor)
//
// Só age no TextEdit, e só num documento que ele mesmo abre. Precisa de
// Acessibilidade (e Gravação de Tela para a captura) no app que roda o node.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.error('O smoke do Computer Use só roda no macOS.')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(here, '..', 'electron', 'lib', 'computer', 'bridges', 'macos.js')
const ACT = process.argv.includes('--act')
const MODE = process.argv.includes('--global') ? 'global' : 'pid'
const MARK = `Orbit smoke ${new Date().toISOString().slice(11, 19)} — ação ✓`

function exec(command, args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }))
      else resolve(String(stdout))
    })
  })
}

async function bridge(op, args = {}) {
  const started = Date.now()
  const out = await exec('osascript', ['-l', 'JavaScript', BRIDGE, JSON.stringify({ op, args })])
  const parsed = JSON.parse(out)
  if (!parsed.ok) throw new Error(`${op}: ${parsed.error.code} — ${parsed.error.message}`)
  return { ...parsed.result, _ms: Date.now() - started }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function step(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  const perms = await bridge('perms')
  step('Acessibilidade', perms.accessibility, perms.accessibility ? '' : 'conceda ao app que roda este terminal')
  if (!perms.accessibility) process.exit(1)

  let scratchFile = null
  if (ACT) {
    // Arquivo próprio do smoke, aberto pelo LaunchServices: nunca um arquivo do
    // usuário, e sem Apple Events (que pediriam a permissão de Automação, que o
    // produto não usa).
    scratchFile = path.join(os.tmpdir(), `orbit-cu-smoke-${process.pid}.txt`)
    fs.writeFileSync(scratchFile, '')
    await exec('open', ['-a', 'TextEdit', scratchFile])
    await sleep(1200)
  }

  const snap = await bridge('apps')
  const app = snap.apps.find((a) => a.bundleId === 'com.apple.TextEdit')
  step('Lista de apps', snap.apps.length > 0, `${snap.apps.length} apps, ${snap.windows.length} janelas em ${snap._ms} ms`)
  if (!app) {
    console.log('  Abra o TextEdit (ou rode com --act) e tente de novo.')
    process.exit(1)
  }
  const scratchName = scratchFile ? path.basename(scratchFile) : null
  const win =
    (scratchName && snap.windows.find((w) => w.pid === app.pid && w.title && w.title.includes(scratchName.replace(/\.txt$/, '')))) ||
    snap.windows.find((w) => w.pid === app.pid)
  step('Janela do TextEdit', Boolean(win), win ? `id ${win.id}, ${win.frame.slice(2).join('×')} pt` : 'sem janela visível')
  if (!win) process.exit(1)

  const tree = await bridge('tree', { pid: app.pid, window: { frame: win.frame, title: win.title }, maxNodes: 250 })
  const textArea = tree.nodes.find((n) => n.role === 'AXTextArea')
  step('Árvore AX', tree.nodes.length > 1, `${tree.nodes.length} nós em ${tree._ms} ms${tree.truncated ? ` (parou: ${tree.truncated})` : ''}`)
  step('Área de texto encontrada', Boolean(textArea), textArea ? `path [${textArea.path}]` : '')

  const file = path.join(os.tmpdir(), `cu-smoke-${process.pid}.png`)
  const shotStart = Date.now()
  try {
    await exec('screencapture', ['-x', '-o', `-l${win.id}`, '-t', 'png', file])
    const kb = Math.round(fs.statSync(file).size / 1024)
    step('Captura da janela', kb > 0, `${Date.now() - shotStart} ms, ${kb} KB`)
  } catch (err) {
    step('Captura da janela', false, `${String(err.stderr || err.message).trim()} (Gravação de Tela?)`)
  } finally {
    fs.rmSync(file, { force: true })
  }

  if (ACT && textArea) {
    const target = { frame: win.frame, title: win.title }
    const focus = await bridge('element', { pid: app.pid, window: target, path: textArea.path, expect: { role: 'AXTextArea' }, kind: 'focus' })
    step('Foco na área de texto (AX)', focus.done === 'focus')
    await bridge('keys', { pid: app.pid, text: MARK, mode: MODE })
    await sleep(400)
    const after = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'info' })
    const typed = (after.node.value ?? '').includes(MARK)
    step(`Digitação Unicode por ${MODE}`, typed, typed ? `${after._ms} ms para ler de volta` : `valor lido: ${JSON.stringify(after.node.value)}`)

    const set = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'setValue', value: `${MARK} (AXValue)` })
    step('set_value via AXValue', set.done === 'setValue', set.readBack ?? '')

    // Segundo plano: o TextEdit vai para trás (o Finder vem para a frente).
    // Evento de mouse por pid é ignorado pelo AppKit (Fase 0), então o modo
    // dirigido clica por hit-test do AX e rola pela barra de rolagem do AX.
    await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'setValue', value: Array.from({ length: 120 }, (_, i) => `linha ${i + 1}`).join('\n') })
    await exec('open', ['-b', 'com.apple.finder'])
    await sleep(600)
    const mouse = () => exec('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var p = $.NSEvent.mouseLocation; Math.round(p.x) + "," + Math.round(p.y)']).then((s) => s.trim())
    const cursorBefore = await mouse()
    const info = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'info' })
    const [fx, fy, fw, fh] = info.node.frame
    const center = [fx + fw / 2, fy + Math.min(fh, 300) / 2]
    const hit = await bridge('hit', { pid: app.pid, x: center[0], y: center[1], focusText: true })
    step('Clique dirigido (hit-test do AX) em segundo plano', hit.done === 'focus' || hit.done === 'press', `${hit.done} em ${hit.node && hit.node.role}`)
    const scrolled = await bridge('scrollAx', { pid: app.pid, x: center[0], y: center[1], dx: 0, dy: -300 })
    const moved = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'info' })
    step('Rolagem dirigida (barra do AX) em segundo plano', scrolled.done === 'scroll' && moved.node.frame[1] < fy, `barra ${scrolled.from} → ${scrolled.to}; área de texto y ${fy} → ${moved.node.frame[1]}`)
    const front = await exec('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)'])
    step('O TextEdit continuou em segundo plano', front.trim() !== 'com.apple.TextEdit', front.trim())
    step('O cursor do usuário não se mexeu', cursorBefore === (await mouse()), cursorBefore)

    if (MODE === 'global') {
      // Clique duplo só existe pelo ponteiro real: seleciona a primeira palavra.
      await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'setValue', value: 'palavra de teste' })
      const top = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'info' })
      await bridge('mouse', { pid: app.pid, windowId: win.id, x: top.node.frame[0] + 24, y: top.node.frame[1] + 12, kind: 'click', button: 'left', clicks: 2, mode: 'global' })
      await sleep(400)
      const selected = (
        await exec('osascript', [
          '-l',
          'JavaScript',
          '-e',
          `ObjC.import("ApplicationServices"); var app = $.AXUIElementCreateApplication(${app.pid}); var o = Ref(); $.AXUIElementCopyAttributeValue(app, $("AXFocusedUIElement"), o); var f = ObjC.castRefToObject(o[0]); var s = Ref(); $.AXUIElementCopyAttributeValue(f, $("AXSelectedText"), s); ObjC.unwrap(ObjC.castRefToObject(s[0]))`,
        ])
      ).trim()
      step('Clique duplo pelo ponteiro global', selected === 'palavra', `selecionado: ${JSON.stringify(selected)}`)
    }

    const stale = await bridge('element', { pid: app.pid, window: target, path: [...textArea.path, 99], kind: 'info' }).then(
      () => false,
      (err) => /staleIndex/.test(String(err.message)),
    )
    step('Índice inexistente vira staleIndex', stale)
    console.log(`\nO documento de teste (${scratchFile}) ficou aberto no TextEdit — feche sem salvar.`)
  }
} catch (err) {
  step('Smoke', false, String(err.message))
}

console.log(failures ? `\n${failures} falha(s).` : '\nTudo certo.')
process.exit(failures ? 1 : 0)
