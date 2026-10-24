import { tool } from 'ai'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolContext } from './context'
import { userShellEnv } from '../shell-env'
import { registerProcess, type ProcessInfo } from '../process-manager'
import { parseFileView, parseInspection, symbolSearchPattern } from '../bash-inspect'

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const MAX_TIMEOUT = 10 * 60 * 1000
/**
 * Saída guardada: o começo E o fim. Guardar só o começo, como antes, perdia
 * justamente o que importa num build ou teste que falha — o erro e o resumo
 * vêm no fim — e o agente rodava de novo para ver. O meio é o que sai.
 */
const OUTPUT_HEAD = 6_000
const OUTPUT_TAIL = 10_000
const SIGKILL_GRACE = 200
// Janela de tolerância após o kill do abort: se o processo não emitiu 'close'
// nesse tempo, o kill falhou (ex.: taskkill sem permissão no Windows) — o
// runShell resolve mesmo assim (nunca deixa o turno do agente preso).
const SETTLE_GRACE_MS = 5000

const execFileAsync = promisify(execFile)

async function killTree(pid: number): Promise<void> {
  const isWin = process.platform === 'win32'
  if (isWin) {
    // taskkill via execFile (assíncrono): execSync BLOQUEAVA o main process —
    // congelava todos os IPC handlers durante o kill, inclusive novos cliques
    // no botão de parar. Falha (exit != 0) é comum (processo já morto) e é
    // coberta pelo watchdog de settle do runShell.
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      // process may have already exited
    }
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
    setTimeout(() => {
      // SIGKILL de reforço caso o SIGTERM não tenha sido suficiente
      try { process.kill(-pid, 'SIGKILL') } catch { /* já encerrou */ }
    }, SIGKILL_GRACE)
  } catch {
    // sem grupo próprio (ex.: spawn sem detached) — cai no kill direto
    try { process.kill(pid, 'SIGTERM') } catch { /* já encerrou */ }
  }
}

function makeLabel(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return `auto: ${flat.slice(0, 60)}${flat.length > 60 ? '…' : ''}`
}

/** Acumula a saída de um processo guardando só o começo e o fim. */
export function createOutputCollector(headChars = OUTPUT_HEAD, tailChars = OUTPUT_TAIL) {
  let head = ''
  let tail = ''
  let total = 0
  return {
    append(text: string) {
      total += text.length
      const room = Math.max(0, headChars - head.length)
      head += text.slice(0, room)
      const rest = text.slice(room)
      if (rest) tail = (tail + rest).slice(-tailChars)
    },
    text(): string {
      const omitted = total - head.length - tail.length
      if (omitted <= 0) return head + tail
      return `${head}\n… (${omitted} characters omitted from the middle of the output) …\n${tail}`
    },
  }
}

function runShell(command: string, cwd: string, timeout: number, abort: AbortSignal, sessionId?: string) {
  return new Promise<{ output: string; exitCode: number | null; background?: ProcessInfo }>(
    (resolve, reject) => {
      const isWin = process.platform === 'win32'
      const child = isWin
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            cwd,
            env: userShellEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        : spawn(process.env.SHELL || '/bin/bash', ['-c', command], {
            cwd,
            env: userShellEnv(),
            // detached:true garante grupo próprio (setsid): o killTree cobre a
            // árvore inteira E a promoção p/ background preserva os filhos.
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })

      const collected = createOutputCollector()
      const append = (chunk: Buffer) => collected.append(chunk.toString('utf8'))
      child.stdout.on('data', append)
      child.stderr.on('data', append)

      const pid = child.pid
      const kill = () => { if (pid != null) void killTree(pid) }

      // Watchdog pós-abort: se o kill falhar silenciosamente (ex.: taskkill
      // sem permissão no Windows), o 'close' nunca chega e a Promise ficaria
      // pendente PARA SEMPRE — o turno do agente trava e o botão de parar vira
      // no-op (o segundo abort é ignorado porque o sinal já foi abortado).
      // Após SETTLE_GRACE_MS, resolve mesmo assim: registra o processo ainda
      // vivo no gerenciador (vira visível e terminável no painel de processos)
      // e devolve a saída parcial com um aviso explícito.
      let settleTimer: NodeJS.Timeout | undefined
      const armSettleWatchdog = () => {
        if (settleTimer) return
        settleTimer = setTimeout(() => {
          if (child.exitCode !== null && child.exitCode !== undefined) return
          child.stdout.removeListener('data', append)
          child.stderr.removeListener('data', append)
          child.removeAllListeners('close')
          child.removeAllListeners('error')
          abort.removeEventListener('abort', onAbort)
          const output = collected.text()
          if (pid == null) {
            resolve({ output, exitCode: null })
            return
          }
          const background = registerProcess(child, {
            label: makeLabel(command),
            command,
            cwd,
            pid,
            initialOutput: output,
            sessionId,
          })
          console.warn(
            `[shell] kill não confirmado após ${SETTLE_GRACE_MS / 1000}s — PID ${pid} ainda vivo; ` +
              'registrado como background (acompanhe/encerre pelo painel de processos)',
          )
          resolve({ output, exitCode: null, background })
        }, SETTLE_GRACE_MS)
      }

      // Timeout promove o comando para background em vez de matar: dev servers
      // (npm run dev) e builds longos continuam vivos, e a tool retorna já com
      // a saída parcial + ponteiro (bash_list/bash_output/bash_kill).
      const timer = setTimeout(() => {
        clearTimeout(timer)
        const output = collected.text()
        if (pid == null) return resolve({ output, exitCode: null })
        child.stdout.removeListener('data', append)
        child.stderr.removeListener('data', append)
        child.removeAllListeners('close')
        child.removeAllListeners('error')
        // A partir daqui o processo é dono da própria vida: o abort do turno
        // (Stop, nova mensagem) NÃO deve derrubá-lo — só bash_kill/lixeira. Sem
        // esta remoção, o abort disparava onAbort e matava o processo promovido.
        abort.removeEventListener('abort', onAbort)
        const background = registerProcess(child, {
          label: makeLabel(command),
          command,
          cwd,
          pid,
          initialOutput: output,
          sessionId,
        })
        resolve({ output, exitCode: null, background })
      }, timeout)

      const onAbort = () => {
        clearTimeout(timer)
        abort.removeEventListener('abort', onAbort)
        kill()
        armSettleWatchdog()
      }
      abort.addEventListener('abort', onAbort)

      child.on('error', (err) => {
        clearTimeout(timer)
        if (settleTimer) clearTimeout(settleTimer)
        abort.removeEventListener('abort', onAbort)
        reject(err)
      })
      child.on('close', (exitCode) => {
        clearTimeout(timer)
        if (settleTimer) clearTimeout(settleTimer)
        abort.removeEventListener('abort', onAbort)
        resolve({ output: collected.text(), exitCode })
      })
    },
  )
}

/** Dicas já dadas neste turno: uma de cada tipo basta, repetir só custa tokens. */
const hintsGiven = new WeakMap<ToolContext, Set<'search' | 'read'>>()

/**
 * Bash usado para ler ou buscar código: aponta a ferramenta certa, uma vez por
 * turno. Depois do code-index o agente passou a fazer MAIS isso (62% das
 * chamadas de bash), por fora do índice e do `read`.
 */
export function inspectionHint(ctx: ToolContext, command: string): string {
  const inspection = parseInspection(command, ctx.directory)
  if (!inspection) return ''
  const given = hintsGiven.get(ctx) ?? new Set()
  hintsGiven.set(ctx, given)
  const symbol = symbolSearchPattern(inspection)
  if (symbol && !given.has('search')) {
    given.add('search')
    return `\n\n[hint: to find where \`${symbol}\` is defined or used, code_search / code_refs answer from the symbol index in one call, with the source and its callers — prefer them over grep through bash.]`
  }
  if (parseFileView(inspection) && !given.has('read')) {
    given.add('read')
    return '\n\n[hint: read files with `read` (line-numbered, what edit expects) or code_outline for the signatures only — not cat/sed/head through bash.]'
  }
  return ''
}

export function createBashTool(ctx: ToolContext) {
  return tool({
    description:
      'Runs a shell command in the working folder and returns stdout/stderr. Use for builds, tests, git, etc. ' +
      'Commands that do not finish within the timeout are NOT killed: they keep running in the background ' +
      '(see bash_list / bash_output / bash_kill). For long-running commands (dev servers, watchers) prefer bash_background.',
    inputSchema: z.object({
      command: z.string().describe('Command to run'),
      description: z.string().optional().describe('Short description of what the command does'),
      timeout: z
        .number()
        .optional()
        .describe(
          'Timeout in milliseconds before the command moves to the background (max 10 minutes, default 2 minutes)',
        ),
    }),
    execute: async ({ command, timeout }) => {
      const ms = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT, 0), MAX_TIMEOUT)
      const { output, exitCode, background } = await runShell(command, ctx.directory, ms, ctx.abort, ctx.sessionId)
      if (background) {
        const partial = output.slice(0, 4000)
        return (
          `(timeout after ${ms / 1000}s — the command was NOT killed, it keeps running in the background)\n` +
          `PID ${background.pid} (label "${background.label}")\n` +
          `Follow it with bash_output and bash_list; stop it with bash_kill (pid ${background.pid}) when no longer needed.\n\n` +
          `Command: ${command}\n\nPartial output:\n${partial || '(no output yet)'}`
        )
      }
      const status = exitCode === 0 ? '' : `\n(exit code: ${exitCode})`
      return `${output || '(no output)'}${inspectionHint(ctx, command)}${status}`
    },
  })
}
