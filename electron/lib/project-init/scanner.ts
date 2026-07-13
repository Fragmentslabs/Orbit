import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Scanner determinístico do /init: varre a estrutura do projeto e os arquivos
 * de configuração para identificar stack, frameworks, ferramentas, testes e
 * infraestrutura — sem LLM. O resultado alimenta a geração de memórias.
 */

export interface ProjectScan {
  name: string
  directory: string
  stack: string[]
  frameworks: string[]
  tools: string[]
  tests: string[]
  infra: string[]
  /** Sinais de UI (frameworks/CSS) — decide se a área design é investigada */
  ui: string[]
  /** Sinais de auth/crypto/secrets — decide se a área security é investigada */
  security: string[]
  scripts: Record<string, string>
  /** Árvore rasa de diretórios (2 níveis) */
  structure: string[]
  readmeExcerpt?: string
  /** Trechos de arquivos de config relevantes para o gerador */
  configExcerpts: { file: string; content: string }[]
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'build', 'out', 'target',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'coverage', '.turbo', 'release',
])

const MAX_EXCERPT = 4000

/** dependência → rótulo (stack/framework/tool/test/infra/ui/security) */
const DEP_SIGNALS: { dep: RegExp; label: string; kind: 'stack' | 'framework' | 'tool' | 'test' | 'ui' | 'security' }[] = [
  { dep: /^(next-auth|@auth\/|@clerk\/|passport|jsonwebtoken|jose$|bcrypt|argon2|@supabase\/)/, label: 'Auth/crypto', kind: 'security' },
  { dep: /^(styled-components|@emotion\/|@mui\/|@chakra-ui\/|@radix-ui\/|@base-ui\/|antd$|shadcn)/, label: 'UI library', kind: 'ui' },
  { dep: /^react$/, label: 'React', kind: 'stack' },
  { dep: /^vue$/, label: 'Vue', kind: 'stack' },
  { dep: /^svelte$/, label: 'Svelte', kind: 'stack' },
  { dep: /^electron$/, label: 'Electron', kind: 'stack' },
  { dep: /^next$/, label: 'Next.js', kind: 'framework' },
  { dep: /^nuxt$/, label: 'Nuxt', kind: 'framework' },
  { dep: /^express$/, label: 'Express', kind: 'framework' },
  { dep: /^fastify$/, label: 'Fastify', kind: 'framework' },
  { dep: /^@nestjs\/core$/, label: 'NestJS', kind: 'framework' },
  { dep: /^@remix-run\//, label: 'Remix', kind: 'framework' },
  { dep: /^astro$/, label: 'Astro', kind: 'framework' },
  { dep: /^vite$/, label: 'Vite', kind: 'tool' },
  { dep: /^webpack$/, label: 'Webpack', kind: 'tool' },
  { dep: /^tailwindcss$/, label: 'Tailwind CSS', kind: 'tool' },
  { dep: /^typescript$/, label: 'TypeScript', kind: 'stack' },
  { dep: /^eslint$/, label: 'ESLint', kind: 'tool' },
  { dep: /^prettier$/, label: 'Prettier', kind: 'tool' },
  { dep: /^@biomejs\/biome$/, label: 'Biome', kind: 'tool' },
  { dep: /^zustand$/, label: 'Zustand', kind: 'tool' },
  { dep: /^ai$/, label: 'Vercel AI SDK', kind: 'tool' },
  { dep: /^vitest$/, label: 'Vitest', kind: 'test' },
  { dep: /^jest$/, label: 'Jest', kind: 'test' },
  { dep: /^@playwright\/test$/, label: 'Playwright', kind: 'test' },
  { dep: /^cypress$/, label: 'Cypress', kind: 'test' },
]

/** arquivo presente → rótulo */
const FILE_SIGNALS: { file: string; label: string; kind: 'stack' | 'tool' | 'test' | 'infra' }[] = [
  { file: 'Cargo.toml', label: 'Rust', kind: 'stack' },
  { file: 'go.mod', label: 'Go', kind: 'stack' },
  { file: 'pyproject.toml', label: 'Python', kind: 'stack' },
  { file: 'requirements.txt', label: 'Python', kind: 'stack' },
  { file: 'Gemfile', label: 'Ruby', kind: 'stack' },
  { file: 'composer.json', label: 'PHP', kind: 'stack' },
  { file: 'pom.xml', label: 'Java (Maven)', kind: 'stack' },
  { file: 'build.gradle', label: 'Java/Kotlin (Gradle)', kind: 'stack' },
  { file: 'Dockerfile', label: 'Docker', kind: 'infra' },
  { file: 'docker-compose.yml', label: 'Docker Compose', kind: 'infra' },
  { file: 'docker-compose.yaml', label: 'Docker Compose', kind: 'infra' },
  { file: '.ruff.toml', label: 'Ruff', kind: 'tool' },
  { file: 'biome.json', label: 'Biome', kind: 'tool' },
  { file: '.prettierrc', label: 'Prettier', kind: 'tool' },
  { file: 'pytest.ini', label: 'pytest', kind: 'test' },
]

/** Configs cujos conteúdos ajudam o gerador (limitados a MAX_EXCERPT) */
const EXCERPT_FILES = [
  'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
  'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile', '.env.example',
  'vite.config.ts', 'next.config.js', 'next.config.ts', 'CLAUDE.md', 'AGENTS.md',
]

async function readIfExists(directory: string, file: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(directory, file), 'utf8')
  } catch {
    return null
  }
}

async function listStructure(directory: string): Promise<string[]> {
  const lines: string[] = []
  const walk = async (dir: string, prefix: string, depth: number) => {
    if (depth > 2) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
      .slice(0, 25)
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).slice(0, 20)
    for (const d of dirs) {
      lines.push(`${prefix}${d.name}/`)
      await walk(path.join(dir, d.name), prefix + '  ', depth + 1)
    }
    if (depth < 2) for (const f of files) lines.push(`${prefix}${f.name}`)
  }
  await walk(directory, '', 0)
  return lines.slice(0, 250)
}

export async function scanProject(directory: string): Promise<ProjectScan> {
  const scan: ProjectScan = {
    name: path.basename(directory),
    directory,
    stack: [],
    frameworks: [],
    tools: [],
    tests: [],
    infra: [],
    ui: [],
    security: [],
    scripts: {},
    structure: await listStructure(directory),
    configExcerpts: [],
  }

  const push = (kind: 'stack' | 'framework' | 'tool' | 'test' | 'infra' | 'ui' | 'security', label: string) => {
    const bucket =
      kind === 'stack' ? scan.stack
      : kind === 'framework' ? scan.frameworks
      : kind === 'tool' ? scan.tools
      : kind === 'test' ? scan.tests
      : kind === 'infra' ? scan.infra
      : kind === 'ui' ? scan.ui
      : scan.security
    if (!bucket.includes(label)) bucket.push(label)
  }

  // package.json: deps + scripts
  const pkgRaw = await readIfExists(directory, 'package.json')
  if (pkgRaw) {
    push('stack', 'Node.js')
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        scripts?: Record<string, string>
      }
      scan.scripts = pkg.scripts ?? {}
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
      for (const dep of deps) {
        for (const signal of DEP_SIGNALS) {
          if (signal.dep.test(dep)) push(signal.kind, signal.label)
        }
      }
      // Frameworks de UI também são sinal de design
      for (const uiDep of ['react', 'vue', 'svelte', 'tailwindcss']) {
        if (deps.includes(uiDep)) push('ui', uiDep)
      }
    } catch {
      // package.json inválido — segue só com os sinais de arquivo
    }
  }

  await Promise.all([
    Promise.all(
      FILE_SIGNALS.map(async (signal) => {
        if (await readIfExists(directory, signal.file)) push(signal.kind, signal.label)
      }),
    ),
    (async () => {
      const workflowsDir = await fs.readdir(path.join(directory, '.github', 'workflows')).catch(() => [] as string[])
      if (workflowsDir.length > 0) push('infra', 'GitHub Actions')
    })(),
    (async () => {
      const envExample = await readIfExists(directory, '.env.example')
      if (envExample && /secret|token|key|auth|password/i.test(envExample)) {
        push('security', 'Variáveis sensíveis (.env)')
      }
    })(),
    (async () => {
      const readme = await readIfExists(directory, 'README.md')
      if (readme) scan.readmeExcerpt = readme.slice(0, MAX_EXCERPT)
    })(),
    ...EXCERPT_FILES.map(async (file) => {
      const content = await readIfExists(directory, file)
      if (content) scan.configExcerpts.push({ file, content: content.slice(0, MAX_EXCERPT) })
    }),
  ])

  return scan
}

/** Resumo textual do scan — vira o prompt do gerador de memórias. */
export function describeScan(scan: ProjectScan): string {
  const section = (title: string, body: string) => (body.trim() ? `## ${title}\n${body}\n` : '')
  return [
    `# Projeto: ${scan.name}\nDiretório: ${scan.directory}`,
    section('Stack', scan.stack.join(', ')),
    section('Frameworks', scan.frameworks.join(', ')),
    section('Ferramentas', scan.tools.join(', ')),
    section('Testes', scan.tests.join(', ')),
    section('Infraestrutura', scan.infra.join(', ')),
    section('Scripts', Object.entries(scan.scripts).map(([k, v]) => `- ${k}: ${v}`).join('\n')),
    section('Estrutura', '```\n' + scan.structure.join('\n') + '\n```'),
    scan.readmeExcerpt ? section('README (trecho)', scan.readmeExcerpt) : '',
    ...scan.configExcerpts.map((c) => section(`Arquivo: ${c.file}`, '```\n' + c.content + '\n```')),
  ]
    .filter(Boolean)
    .join('\n')
}
