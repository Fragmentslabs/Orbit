#!/usr/bin/env node
/**
 * Peak memory of a process TREE, for the commands a turn starts.
 *
 * Why: the app's own memory is small next to what an agent's checks cost. A single
 * `tsc --noEmit` on this monorepo peaks around 2 GB, and an orchestra wave runs
 * one per worker — that is the number behind "the app was using 26 GB", and it is
 * invisible to `process.memoryUsage()` because it lives in the children.
 *
 * Usage:
 *   node scripts/tree-memory.mjs [--parallel N] [--ms 250] -- <command…>
 *
 * Examples:
 *   node scripts/tree-memory.mjs --parallel 1 -- npx tsc --noEmit
 *   node scripts/tree-memory.mjs --parallel 4 -- npx tsc --noEmit
 *   node scripts/tree-memory.mjs --parallel 2 -- npx vitest run electron/lib
 *
 * It samples `ps` (pid, ppid, rss) and follows the tree from each spawned pid,
 * which is what catches `npx` → `node` → the compiler.
 */

import { spawn } from 'node:child_process'

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : fallback
}

const dash = process.argv.indexOf('--')
const command = dash >= 0 ? process.argv.slice(dash + 1) : []
if (command.length === 0) {
  console.error('usage: node scripts/tree-memory.mjs [--parallel N] [--ms 250] -- <command…>')
  process.exit(2)
}

const parallel = arg('parallel', 1)
const intervalMs = arg('ms', 250)
const MB = 1024

function table() {
  return new Promise((resolve) => {
    const ps = spawn('ps', ['-axo', 'pid=,ppid=,rss=,args='])
    let out = ''
    ps.stdout.on('data', (data) => (out += data))
    ps.on('close', () => {
      const rows = []
      for (const line of out.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        if (!match) continue
        rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), command: match[4].trim() })
      }
      resolve(rows)
    })
  })
}

const children = Array.from({ length: parallel }, () =>
  spawn(command[0], command.slice(1), { stdio: 'ignore' }),
)
const roots = children.map((child) => child.pid)
const startedAt = Date.now()

let peak = 0
let peakTop = []
let samples = 0

const timer = setInterval(async () => {
  const rows = await table()
  const inTree = new Set(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (inTree.has(row.ppid) && !inTree.has(row.pid)) {
        inTree.add(row.pid)
        changed = true
      }
    }
  }
  const mine = rows.filter((row) => inTree.has(row.pid))
  const total = mine.reduce((sum, row) => sum + row.rss, 0)
  samples += 1
  if (total > peak) {
    peak = total
    peakTop = mine
      .sort((a, b) => b.rss - a.rss)
      .slice(0, 6)
      .map((row) => `${Math.round(row.rss / MB)}MB  ${row.command.slice(0, 90)}`)
  }
}, intervalMs)

await Promise.all(
  children.map((child) => new Promise((resolve) => child.on('close', resolve))),
)
clearInterval(timer)

console.log(
  JSON.stringify(
    {
      command: command.join(' '),
      parallel,
      wallSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
      peakTreeGb: Math.round((peak / MB / MB) * 100) / 100,
      samples,
      top: peakTop,
    },
    null,
    1,
  ),
)
