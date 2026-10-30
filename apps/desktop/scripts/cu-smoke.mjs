#!/usr/bin/env node
// Manual smoke test of Computer Use, without an LLM: runs the app's bridge against a
// real TextEdit and checks the whole loop — listing, reading the tree,
// typing, reading back, clicking by accessibility and capturing.
//
// Usage:
//   node scripts/cu-smoke.mjs           read only (list, tree, capture)
//   node scripts/cu-smoke.mjs --act     also types in a new TextEdit document
//   node scripts/cu-smoke.mjs --global  actions through the real pointer (moves the cursor)
//
// It only acts on TextEdit, and only on a document it opens itself. Requires
// Accessibility (and Screen Recording for the capture) on the app that runs node.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.error('The Computer Use smoke test only runs on macOS.')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(here, '..', 'electron', 'lib', 'computer', 'bridges', 'macos.js')
const ACT = process.argv.includes('--act')
const MODE = process.argv.includes('--global') ? 'global' : 'pid'
const MARK = `Orbit smoke ${new Date().toISOString().slice(11, 19)} — action ✓`

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
  step('Accessibility', perms.accessibility, perms.accessibility ? '' : 'grant it to the app that runs this terminal')
  if (!perms.accessibility) process.exit(1)

  let scratchFile = null
  if (ACT) {
    // Smoke's own file, opened by LaunchServices: never a file of the
    // user, and without Apple Events (which would ask for the Automation permission, which the
    // product does not use).
    scratchFile = path.join(os.tmpdir(), `orbit-cu-smoke-${process.pid}.txt`)
    fs.writeFileSync(scratchFile, '')
    await exec('open', ['-a', 'TextEdit', scratchFile])
    await sleep(1200)
  }

  const snap = await bridge('apps')
  const app = snap.apps.find((a) => a.bundleId === 'com.apple.TextEdit')
  step('App list', snap.apps.length > 0, `${snap.apps.length} apps, ${snap.windows.length} windows in ${snap._ms} ms`)
  if (!app) {
    console.log('  Open TextEdit (or run with --act) and try again.')
    process.exit(1)
  }
  const scratchName = scratchFile ? path.basename(scratchFile) : null
  const win =
    (scratchName && snap.windows.find((w) => w.pid === app.pid && w.title && w.title.includes(scratchName.replace(/\.txt$/, '')))) ||
    snap.windows.find((w) => w.pid === app.pid)
  step('TextEdit window', Boolean(win), win ? `id ${win.id}, ${win.frame.slice(2).join('×')} pt` : 'no visible window')
  if (!win) process.exit(1)

  const tree = await bridge('tree', { pid: app.pid, window: { frame: win.frame, title: win.title }, maxNodes: 250 })
  const textArea = tree.nodes.find((n) => n.role === 'AXTextArea')
  step('AX tree', tree.nodes.length > 1, `${tree.nodes.length} nodes in ${tree._ms} ms${tree.truncated ? ` (stopped: ${tree.truncated})` : ''}`)
  step('Text area found', Boolean(textArea), textArea ? `path [${textArea.path}]` : '')

  const file = path.join(os.tmpdir(), `cu-smoke-${process.pid}.png`)
  const shotStart = Date.now()
  try {
    await exec('screencapture', ['-x', '-o', `-l${win.id}`, '-t', 'png', file])
    const kb = Math.round(fs.statSync(file).size / 1024)
    step('Window capture', kb > 0, `${Date.now() - shotStart} ms, ${kb} KB`)
  } catch (err) {
    step('Window capture', false, `${String(err.stderr || err.message).trim()} (Screen Recording?)`)
  } finally {
    fs.rmSync(file, { force: true })
  }

  if (ACT && textArea) {
    const target = { frame: win.frame, title: win.title }
    const focus = await bridge('element', { pid: app.pid, window: target, path: textArea.path, expect: { role: 'AXTextArea' }, kind: 'focus' })
    step('Focus on the text area (AX)', focus.done === 'focus')
    await bridge('keys', { pid: app.pid, text: MARK, mode: MODE })
    await sleep(400)
    const after = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'info' })
    const typed = (after.node.value ?? '').includes(MARK)
    step(`Unicode typing through ${MODE}`, typed, typed ? `${after._ms} ms to read back` : `value read: ${JSON.stringify(after.node.value)}`)

    const set = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'setValue', value: `${MARK} (AXValue)` })
    step('set_value via AXValue', set.done === 'setValue', set.readBack ?? '')

    // Background: TextEdit goes behind (the Finder comes to the front).
    // A mouse event by pid is ignored by AppKit (Phase 0), so the
    // directed mode clicks by AX hit-test and scrolls through the AX scrollbar.
    await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'setValue', value: Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n') })
    await exec('open', ['-b', 'com.apple.finder'])
    await sleep(600)
    const mouse = () => exec('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var p = $.NSEvent.mouseLocation; Math.round(p.x) + "," + Math.round(p.y)']).then((s) => s.trim())
    const cursorBefore = await mouse()
    const info = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'info' })
    const [fx, fy, fw, fh] = info.node.frame
    const center = [fx + fw / 2, fy + Math.min(fh, 300) / 2]
    const hit = await bridge('hit', { pid: app.pid, x: center[0], y: center[1], focusText: true })
    step('Directed click (AX hit-test) in the background', hit.done === 'focus' || hit.done === 'press', `${hit.done} in ${hit.node && hit.node.role}`)
    const scrolled = await bridge('scrollAx', { pid: app.pid, x: center[0], y: center[1], dx: 0, dy: -300 })
    const moved = await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'info' })
    step('Directed scroll (AX scrollbar) in the background', scrolled.done === 'scroll' && moved.node.frame[1] < fy, `scrollbar ${scrolled.from} → ${scrolled.to}; text area y ${fy} → ${moved.node.frame[1]}`)
    const front = await exec('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)'])
    step('TextEdit stayed in the background', front.trim() !== 'com.apple.TextEdit', front.trim())
    step('The user cursor did not move', cursorBefore === (await mouse()), cursorBefore)

    if (MODE === 'global') {
      // Double click only exists through the real pointer: it selects the first word.
      await bridge('element', { pid: app.pid, window: target, path: textArea.path, kind: 'setValue', value: 'test word' })
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
      step('Double click through the global pointer', selected === 'test', `selected: ${JSON.stringify(selected)}`)
    }

    const stale = await bridge('element', { pid: app.pid, window: target, path: [...textArea.path, 99], kind: 'info' }).then(
      () => false,
      (err) => /staleIndex/.test(String(err.message)),
    )
    step('Nonexistent index becomes staleIndex', stale)
    console.log(`\nThe test document (${scratchFile}) stayed open in TextEdit — close it without saving.`)
  }
} catch (err) {
  step('Smoke', false, String(err.message))
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll good.')
process.exit(failures ? 1 : 0)
