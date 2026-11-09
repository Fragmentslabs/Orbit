import { FRAGMENT_KINDS, type FragmentKind } from '@orbit/shared/fragments'
import { FRAGMENT_SDK_VERSION, type FragmentIssue } from '@orbit/shared/fragment-rules'
import cliPackage from '../package.json'
import { scaffoldFragment } from './scaffold'
import { validateFragmentFolder } from './validate'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = `orbit-fragments ${cliPackage.version} (fragment sdk ${FRAGMENT_SDK_VERSION})

Usage:
  orbit-fragments init <dir> [--name <name>] [--kind ${FRAGMENT_KINDS.join('|')}]
      Create a small working fragment in <dir> (new or empty).
  orbit-fragments validate [dir] [--json]
      Check manifest.json and src/ against the rules Orbit enforces. Exit code 1 on errors.
  orbit-fragments --version | --help
`

interface Parsed {
  command: string | undefined
  positional: string[]
  flags: Map<string, string | true>
}

const VALUE_FLAGS = new Set(['name', 'kind'])
const BOOLEAN_FLAGS = new Set(['json', 'help', 'version'])

function parse(args: string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2)
    if (BOOLEAN_FLAGS.has(key)) flags.set(key, true)
    else if (VALUE_FLAGS.has(key)) {
      const value = inline ?? args[++i]
      if (value === undefined) throw new Error(`--${key} needs a value`)
      flags.set(key, value)
    } else throw new Error(`unknown option --${key}`)
  }
  return { command: positional.shift(), positional, flags }
}

function formatIssue(issue: FragmentIssue): string {
  return `  ${issue.severity === 'error' ? '✖' : '!'} ${issue.where}: ${issue.message}`
}

/** Runs the CLI and returns the process exit code. */
export async function run(args: string[], io: CliIo): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parse(args)
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`)
    return 2
  }
  const { command, positional, flags } = parsed

  if (flags.has('version')) {
    io.out(cliPackage.version)
    return 0
  }
  if (flags.has('help') || !command) {
    io.out(USAGE)
    return command || flags.has('help') ? 0 : 2
  }

  try {
    if (command === 'init') {
      const dir = positional[0]
      if (!dir) throw new Error('init needs a folder: orbit-fragments init <dir>')
      const kind = flags.get('kind')
      if (kind !== undefined && !FRAGMENT_KINDS.includes(kind as FragmentKind)) {
        throw new Error(`--kind must be one of: ${FRAGMENT_KINDS.join(', ')}`)
      }
      const name = flags.get('name')
      const created = await scaffoldFragment({
        dir,
        name: typeof name === 'string' ? name : undefined,
        kind: kind as FragmentKind | undefined,
      })
      io.out(`Created ${dir}:\n${created.map((f) => `  ${f}`).join('\n')}\n\nNext: orbit-fragments validate ${dir}`)
      return 0
    }

    if (command === 'validate') {
      const report = await validateFragmentFolder(positional[0] ?? '.')
      if (flags.has('json')) {
        io.out(JSON.stringify(report, null, 2))
        return report.ok ? 0 : 1
      }
      const errors = report.issues.filter((i) => i.severity === 'error')
      const warnings = report.issues.filter((i) => i.severity === 'warning')
      if (report.issues.length > 0) io.out(report.issues.map(formatIssue).join('\n'))
      io.out(
        report.ok
          ? `✔ ${report.dir} is valid (${report.files} file${report.files === 1 ? '' : 's'}${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''})`
          : `✖ ${report.dir} has ${errors.length} error${errors.length === 1 ? '' : 's'}`,
      )
      return report.ok ? 0 : 1
    }

    io.err(`unknown command "${command}"\n\n${USAGE}`)
    return 2
  } catch (error) {
    io.err((error as Error).message)
    return 1
  }
}
