/**
 * How a script uses a secret without ever holding it. The script only names the secret and the
 * scheme; the main process looks up the value, adds the header to a request that already passed
 * the host check, and scrubs the value from everything that goes back. Pure functions.
 */

export type SecretReader = (name: string) => Promise<string | null>

/** `Authorization: <scheme> <secret>`, or the secret alone in a header of the script's choosing. */
const SCHEMES = new Set(['Bearer', 'Basic', 'Token'])
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'set-cookie', 'content-length', 'transfer-encoding', 'connection'])

export interface AuthRequest {
  secret: string
  scheme?: string
  header?: string
}

export function parseAuth(raw: unknown): AuthRequest | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'auth must be { secret, scheme?, header? }.' }
  const { secret, scheme, header } = raw as Record<string, unknown>
  if (typeof secret !== 'string' || secret === '') return { error: 'auth.secret must name a secret.' }
  if (scheme !== undefined && (typeof scheme !== 'string' || !SCHEMES.has(scheme))) return { error: 'auth.scheme must be Bearer, Basic or Token.' }
  if (header !== undefined && (typeof header !== 'string' || !HEADER_NAME.test(header) || FORBIDDEN_HEADERS.has(header.toLowerCase()))) {
    return { error: 'auth.header is not an allowed header name.' }
  }
  return { secret, scheme: scheme as string | undefined, header: header as string | undefined }
}

/**
 * Adds the header for `auth` to the request headers. The secret must be one the script declared
 * (and the person approved) and must be stored; the value goes into `used` so the run can scrub it.
 * The caller has already checked the host, and redirects are off, so it only reaches that host.
 */
export async function applyAuth(
  raw: unknown,
  declared: readonly string[],
  read: SecretReader,
  used: Set<string>,
  headers: Record<string, string>,
): Promise<void> {
  const auth = parseAuth(raw)
  if ('error' in auth) throw new Error(auth.error)
  if (!declared.includes(auth.secret)) throw new Error(`The script did not declare the secret ${auth.secret}.`)
  const value = await read(auth.secret)
  if (value === null) throw new Error(`The secret ${auth.secret} is not stored. Ask the person to add it.`)
  used.add(value)
  const sent = auth.scheme === 'Basic' ? Buffer.from(value).toString('base64') : value
  headers[auth.header ?? 'Authorization'] = auth.scheme ? `${auth.scheme} ${sent}` : sent
}

/** Every spelling of a secret a text could carry: raw, JSON-escaped, URL-encoded, base64. */
function forms(value: string): string[] {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64')].filter((v) => v.length > 0)
}

/** Replaces the secret values in a text. Longest first, so a form inside another cannot survive. */
export function redactText(text: string, secrets: Iterable<string>): string {
  const all = [...new Set([...secrets].flatMap(forms))].sort((a, b) => b.length - a.length)
  let out = text
  for (const form of all) out = out.split(form).join('[secret]')
  return out
}

/** The same, through any JSON-like value (strings are cleaned, keys too). */
export function redactDeep<T>(value: T, secrets: ReadonlySet<string>): T {
  if (secrets.size === 0) return value
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactText(v, secrets)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactText(k, secrets), walk(x)]))
    return v
  }
  return walk(value) as T
}
