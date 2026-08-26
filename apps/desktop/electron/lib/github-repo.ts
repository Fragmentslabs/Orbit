import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { userShellEnv } from './shell-env'

/**
 * Criação do repositório remoto no GitHub a partir de uma pasta que ainda não
 * tem remote — o caso em que `git push` falha com kind "noRemote".
 *
 * O token NÃO é pedido ao usuário nem guardado por nós: é lido do credential
 * helper que o próprio git já usa para autenticar os pushes (Git Credential
 * Manager no Windows, keychain no macOS) e, na falta dele, do `gh auth token`.
 *
 * Quem autentica por SSH não tem credencial HTTPS nenhuma — o push funciona
 * pelas chaves, mas a API do GitHub exige token, e chave SSH não vira token.
 * Nesse caso o `gh` é a fonte que resta — e o erro aponta a instalação e a
 * autenticação dele em vez de pedir token digitado. O remote criado segue o
 * protocolo que a máquina sabe usar: HTTPS quando há credencial HTTPS, SSH
 * caso contrário — senão o push logo após a criação falharia.
 */

const execFileAsync = promisify(execFile)

const API = 'https://api.github.com'

/**
 * PATH completo do usuário, não o sanitizado que o macOS entrega a apps de
 * GUI. Sem isto o `gh` do Homebrew (/opt/homebrew/bin) fica invisível — o
 * `git` escapa porque mora em /usr/bin, que está no PATH mínimo.
 * userShellEnv lê o disco, então o resultado é memoizado.
 */
let envCache: NodeJS.ProcessEnv | undefined
function gitEnv(): NodeJS.ProcessEnv {
  envCache ??= userShellEnv()
  return { ...envCache, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
}

export type CreateRepoResult =
  | { ok: true; url: string; fullName: string; pushed: boolean }
  | {
      ok: false
      kind: 'noCredential'
      hint: CredentialHint
      // Dados crus das duas tentativas — a UI monta o texto no idioma ativo.
      detalhe: { git: GitCredDetalhe; gh: GhCredDetalhe }
    }
  | { ok: false; kind: Exclude<CreateRepoErrorKind, 'noCredential'>; message: string }

/**
 * Instrução que a UI mostra para desbloquear a criação de repositório:
 * `ghMissing` = o `gh` não está instalado (instalar e autenticar);
 * `ghOther` = o `gh` existe mas não forneceu token (autenticar).
 */
export type CredentialHint = 'ghMissing' | 'ghOther'

export type CreateRepoErrorKind =
  /** Sem credencial do GitHub no helper do git — nada a reaproveitar. */
  | 'noCredential'
  /** Token existe mas foi recusado ou não tem escopo para criar repositório. */
  | 'auth'
  /** Já existe um repositório com esse nome na conta. */
  | 'nameTaken'
  /** Nome fora das regras do GitHub. */
  | 'invalidName'
  /** A pasta ainda não tem nenhum commit — não há o que publicar. */
  | 'noCommits'
  | 'other'

/** Regras do GitHub para nome de repositório: letras, números, `.`, `-` e `_`. */
export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..'
}

interface TokenLookup {
  token: string | null
  /**
   * Existe credencial HTTPS no helper do git. Decide o protocolo do remote:
   * sem ela, a máquina autentica por SSH e um origin HTTPS não daria push.
   */
  hasHttpsCredential: boolean
  /** Quando não veio token, como a leitura falhou — a UI traduz a partir disto. */
  detalhe: GitCredDetalhe | null
}

/**
 * Como o `git credential fill` terminou sem token. `saida` é a saída crua da
 * ferramenta (stderr — nunca traduzida); `modo` e `codigo` viram texto
 * localizado na UI.
 */
export type GitCredDetalhe = {
  modo: 'exit' | 'spawn' | 'timeout'
  /** Código de saída do git (modo 'exit'); null nos demais modos. */
  codigo: number | null
  saida: string
}

/** Estado do `gh auth token` quando não veio token — a UI localiza, `saida` crua à parte. */
export type GhCredDetalhe = {
  estado: 'missing' | 'other'
  saida: string
}

/** Token do GitHub CLI, quando instalado e autenticado. */
async function readGhToken(
  cwd: string,
): Promise<{ token: string | null; estado: 'ok' | 'missing' | 'other'; saida: string }> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      cwd,
      env: gitEnv(),
      timeout: 10_000,
    })
    const token = stdout.trim()
    return token
      ? { token, estado: 'ok', saida: '' }
      : { token: null, estado: 'other', saida: '' }
  } catch (err) {
    const e = err as { code?: string; stderr?: string }
    // ENOENT = binário ausente; qualquer outra saída = gh existe mas recusou.
    // A saída crua do gh vai para a UI sem tradução — só a moldura é localizada.
    const missing = e.code === 'ENOENT'
    return {
      token: null,
      estado: missing ? 'missing' : 'other',
      saida: missing ? '' : (e.stderr ?? '').trim().slice(0, 200) || String(err).slice(0, 200),
    }
  }
}

/**
 * Lê a credencial do github.com pelo helper do git.
 *
 * Roda com stdin explícito porque `git credential fill` espera a consulta por
 * lá. Toda saída sem token devolve o MOTIVO: um "sem credencial" seco não
 * distingue helper ausente, tempo esgotado e git não encontrado, e sem essa
 * distinção não há como o usuário agir.
 */
async function readGitHubToken(cwd: string): Promise<TokenLookup> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['credential', 'fill'], { cwd, env: gitEnv() })
    } catch (err) {
      resolve({
        token: null,
        hasHttpsCredential: false,
        detalhe: { modo: 'spawn', codigo: null, saida: err instanceof Error ? err.message : String(err) },
      })
      return
    }

    let out = ''
    let errOut = ''
    let settled = false
    const finish = (result: TokenLookup) => {
      if (settled) return
      settled = true
      child.kill()
      resolve(result)
    }
    // 20s: o Git Credential Manager é uma app .NET e a primeira invocação num
    // processo frio passa dos 10s que eu usava antes.
    const timer = setTimeout(
      () => finish({ token: null, hasHttpsCredential: false, detalhe: { modo: 'timeout', codigo: null, saida: '' } }),
      20_000,
    )

    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      errOut += String(chunk)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ token: null, hasHttpsCredential: false, detalhe: { modo: 'spawn', codigo: null, saida: err.message } })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const password = out
        .split(/\r?\n/)
        .find((line) => line.startsWith('password='))
        ?.slice('password='.length)
        .trim()
      if (password) {
        finish({ token: password, hasHttpsCredential: true, detalhe: null })
        return
      }
      // Qualquer saída sem `password=` significa a mesma coisa: não há
      // credencial HTTPS. Numa máquina só-SSH o git chega a tentar perguntar
      // o usuário e sai 128 com "terminal prompts disabled". A cauda crua do
      // stderr vai para a UI; a moldura textual é montada lá, no idioma ativo.
      const saida = errOut.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)
      finish({
        token: null,
        hasHttpsCredential: false,
        detalhe: { modo: 'exit', codigo: code, saida },
      })
    })

    child.stdin?.write('protocol=https\nhost=github.com\n\n')
    child.stdin?.end()
  })
}

interface GitHubRepo {
  /** HTTPS */
  clone_url: string
  /** git@github.com:owner/name.git */
  ssh_url: string
  full_name: string
  html_url: string
}

async function createOnGitHub(
  name: string,
  isPrivate: boolean,
  token: string,
): Promise<{ ok: true; repo: GitHubRepo } | { ok: false; kind: Exclude<CreateRepoErrorKind, 'noCredential'>; message: string }> {
  let response: Response
  try {
    response = await fetch(`${API}/user/repos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'Orbit',
      },
      body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    return { ok: false, kind: 'other', message: err instanceof Error ? err.message : String(err) }
  }

  if (response.status === 201) {
    return { ok: true, repo: (await response.json()) as GitHubRepo }
  }

  const body = (await response.json().catch(() => null)) as
    | { message?: string; errors?: { message?: string }[] }
    | null
  const detail = body?.errors?.[0]?.message ?? body?.message ?? `HTTP ${response.status}`

  if (response.status === 401 || response.status === 403) {
    return { ok: false, kind: 'auth', message: detail }
  }
  if (response.status === 422) {
    // O GitHub devolve 422 tanto para nome repetido quanto para nome inválido.
    const kind: CreateRepoErrorKind = /already exists/i.test(detail) ? 'nameTaken' : 'invalidName'
    return { ok: false, kind, message: detail }
  }
  return { ok: false, kind: 'other', message: detail }
}

/**
 * Cria o repositório no GitHub, aponta o remote `origin` para ele e publica a
 * branch atual. Devolve `pushed: false` quando o repositório foi criado mas o
 * push falhou — o remote fica configurado, então o usuário pode tentar de novo
 * pelo próprio botão de enviar.
 */
export async function createRemoteRepo(
  repoPath: string,
  name: string,
  isPrivate: boolean,
): Promise<CreateRepoResult> {
  const trimmed = name.trim()
  if (!isValidRepoName(trimmed)) {
    return { ok: false, kind: 'invalidName', message: trimmed }
  }

  // Publicar exige ao menos um commit: sem HEAD, o push não tem o que enviar e
  // o repositório remoto nasceria órfão do local.
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, env: gitEnv(), timeout: 15_000 })
  } catch {
    return { ok: false, kind: 'noCommits', message: 'HEAD ausente' }
  }

  // A leitura define também o protocolo do remote: sem credencial HTTPS a
  // máquina autentica por SSH e o origin nasce com a URL SSH.
  const lido = await readGitHubToken(repoPath)
  let token = lido.token
  if (!token) {
    // Sem credencial HTTPS (típico de quem usa SSH) o gh é a única fonte que
    // resta — o hint diz à UI se é preciso instalar ou só autenticar.
    const gh = await readGhToken(repoPath)
    token = gh.token
    if (!token) {
      // As duas tentativas entram no detalhe: saber qual delas falhou e por quê
      // é o que permite ao usuário corrigir em vez de adivinhar. A UI recebe
      // os dados crus e monta o texto no idioma ativo.
      return {
        ok: false,
        kind: 'noCredential',
        hint: gh.estado === 'missing' ? 'ghMissing' : 'ghOther',
        detalhe: {
          git: lido.detalhe ?? { modo: 'exit', codigo: null, saida: '' },
          gh: { estado: gh.estado === 'ok' ? 'other' : gh.estado, saida: gh.saida },
        },
      }
    }
  }

  const created = await createOnGitHub(trimmed, isPrivate, token)
  if (!created.ok) return created

  // Protocolo que esta máquina consegue autenticar: com credencial HTTPS vai
  // de HTTPS; sem ela o push só funciona pelas chaves SSH.
  const remoteUrl = lido.hasHttpsCredential ? created.repo.clone_url : created.repo.ssh_url

  try {
    await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], {
      cwd: repoPath,
      env: gitEnv(),
      timeout: 15_000,
    })
  } catch (err) {
    return {
      ok: false,
      kind: 'other',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: repoPath,
      env: gitEnv(),
      timeout: 15_000,
    })
    const branch = stdout.trim()
    if (!branch) throw new Error('sem branch atual')
    await execFileAsync('git', ['push', '-u', 'origin', branch], {
      cwd: repoPath,
      env: gitEnv(),
      timeout: 120_000,
    })
    return { ok: true, url: created.repo.html_url, fullName: created.repo.full_name, pushed: true }
  } catch {
    // O repositório existe e o origin está configurado; só o envio falhou.
    return { ok: true, url: created.repo.html_url, fullName: created.repo.full_name, pushed: false }
  }
}
