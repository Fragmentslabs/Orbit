/**
 * Profile of the saved conversations, read-only: how much of the history is
 * conversation text versus tool output and reasoning, and what a full parse and a
 * linear scan cost. It is the baseline for the in-memory session index.
 *
 *   node scripts/measure-sessions.mjs                  # the real profile
 *   node scripts/measure-sessions.mjs launchagent      # + hits for a term
 *   ORBIT_DATA=/path/to/orbit-data node scripts/measure-sessions.mjs
 *
 * Nothing is ever written: files are opened for reading only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir =
  process.env.ORBIT_DATA ??
  path.join(os.homedir(), 'Library', 'Application Support', '@orbit', 'desktop', 'orbit-data')
const storage = path.join(dataDir, 'storage')
const messagesDir = path.join(storage, 'messages')
const sessionDir = path.join(storage, 'session')
const term = process.argv[2]?.toLowerCase()

if (!fs.existsSync(messagesDir)) {
  console.error(`no messages directory: ${messagesDir}`)
  process.exit(1)
}

const mb = (n) => (n / 1e6).toFixed(1)
const pct = (n, total) => (total ? ((n / total) * 100).toFixed(1) : '0.0')
const files = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'))

const fold = (s) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')

let totalBytes = 0
const parts = {} // type -> { count, bytes }
const bump = (key, bytes) => {
  const slot = (parts[key] ??= { count: 0, bytes: 0 })
  slot.count++
  slot.bytes += bytes
}

const parsed = []
const tParse = performance.now()
for (const f of files) {
  const file = path.join(messagesDir, f)
  const raw = fs.readFileSync(file, 'utf8')
  totalBytes += Buffer.byteLength(raw)
  try {
    parsed.push({ id: f.slice(0, -5), messages: JSON.parse(raw) })
  } catch {
    console.error(`skipped (invalid JSON): ${f}`)
  }
}
const parseMs = performance.now() - tParse

let messageCount = 0
let indexable = 0 // user/assistant text that the index would keep
const sessionsWithTerm = new Set()
const tScan = performance.now()
for (const { id, messages } of parsed) {
  for (const msg of messages) {
    messageCount++
    for (const p of msg.parts ?? []) {
      if (p.type === 'text') {
        const bytes = Buffer.byteLength(p.text ?? '')
        bump(p.source === 'attachment' ? 'text (attachment)' : 'text', bytes)
        if (p.source !== 'attachment') indexable += bytes
        if (term && fold(p.text ?? '').includes(term)) sessionsWithTerm.add(id)
      } else if (p.type === 'reasoning') {
        bump('reasoning', Buffer.byteLength(p.text ?? ''))
      } else if (p.type === 'tool') {
        bump('tool', Buffer.byteLength(JSON.stringify(p.input ?? '')) + Buffer.byteLength(p.output ?? '') + Buffer.byteLength(p.error ?? ''))
      } else {
        bump(p.type, Buffer.byteLength(JSON.stringify(p)))
      }
    }
  }
}
const scanMs = performance.now() - tScan

const partBytes = Object.values(parts).reduce((a, p) => a + p.bytes, 0)
console.log(`profile        ${dataDir}`)
console.log(`sessions       ${files.length} message files, ${messageCount} messages`)
console.log(`on disk        ${mb(totalBytes)} MB (JSON, indented)`)
console.log(`part payload   ${mb(partBytes)} MB`)
console.log('')
console.log('by part type'.padEnd(20) + 'count'.padStart(8) + 'MB'.padStart(10) + '%'.padStart(8))
for (const [type, p] of Object.entries(parts).sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(type.padEnd(20) + String(p.count).padStart(8) + mb(p.bytes).padStart(10) + pct(p.bytes, partBytes).padStart(8))
}
console.log('')
console.log(`indexable text ${mb(indexable)} MB (user/assistant text, no attachments) = ${pct(indexable, totalBytes)}% of disk`)
console.log(`parse          ${parseMs.toFixed(0)} ms (read + JSON.parse of every messages file)`)
console.log(`scan           ${scanMs.toFixed(0)} ms (walk all parts${term ? ` + fold/includes for "${term}"` : ''})`)

if (term) {
  const titles = new Map()
  if (fs.existsSync(sessionDir)) {
    for (const f of fs.readdirSync(sessionDir).filter((n) => n.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionDir, f), 'utf8'))
        titles.set(s.id, s)
      } catch {
        /* ignore */
      }
    }
  }
  const recent = [...titles.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
  const recentIds = new Set(recent.map((s) => s.id))
  const all = [...sessionsWithTerm]
  const capped = all.filter((id) => recentIds.has(id))
  console.log('')
  console.log(`"${term}": ${all.length} sessions with a hit in text parts; ${capped.length} inside the 40 most recent`)
}
