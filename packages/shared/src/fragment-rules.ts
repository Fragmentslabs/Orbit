/**
 * The rules a fragment must satisfy, in one place with no Node or Electron dependency:
 * the app enforces them when it writes or serves a fragment, and `orbit-fragments`
 * (the CLI) enforces the same ones on a folder before it ever reaches the app.
 */
import {
  FRAGMENT_CAPABILITIES,
  FRAGMENT_DEFAULT_ICON,
  FRAGMENT_ICON_PATTERN,
  FRAGMENT_KINDS,
  FRAGMENT_MAX_WIDGETS,
  FRAGMENT_WIDGET_ID_PATTERN,
  FRAGMENT_WIDGET_SIZES,
  isFragmentId,
  type FragmentCapability,
  type FragmentKind,
  type FragmentMethod,
  type FragmentModel,
  type FragmentPins,
  type FragmentReasoning,
  type FragmentWidget,
} from "./fragments"

/** Major version of the `window.orbit` API (the bridge protocol). A manifest's `sdk` must equal it. */
export const FRAGMENT_SDK_VERSION = 1

/** Every method the page can call through `window.orbit`. */
export const FRAGMENT_METHODS = [
  "store.get",
  "store.set",
  "store.delete",
  "store.keys",
  "ai.generate",
  "models.list",
  "models.get",
  "models.set",
  "http.fetch",
  "mcp.list",
  "mcp.call",
  "notify.show",
  "notify.schedule",
  "notify.list",
  "notify.cancel",
  "permissions.state",
  "permissions.request",
] as const

// Compile-time guard: the runtime list and the `FragmentMethod` type must name the same methods.
type MethodsMatch = FragmentMethod extends (typeof FRAGMENT_METHODS)[number]
  ? (typeof FRAGMENT_METHODS)[number] extends FragmentMethod
    ? true
    : never
  : never
export const FRAGMENT_METHODS_MATCH_TYPE: MethodsMatch = true

/** The entry document inside `src/`. */
export const FRAGMENT_ENTRY = "index.html"

/** Per-file cap. The page is written by a model: above this it is a data dump. */
export const FRAGMENT_MAX_FILE_BYTES = 1024 * 1024
export const FRAGMENT_MAX_FILES = 60
export const FRAGMENT_MAX_NAME_LENGTH = 80
export const FRAGMENT_MAX_ICON_LENGTH = 48

/** Extensions the scheme may serve — text the page loads, plus small static assets. */
export const FRAGMENT_SERVED_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/**
 * A relative path INSIDE `src/` as its segments, or the reason it is refused. Absolute
 * paths, `..`, hidden names and extensions the scheme would not serve are refused — the
 * same function guards the agent's writes and the scheme's reads.
 */
export function checkFragmentSrcPath(rel: unknown): { ok: true; parts: string[] } | { ok: false; reason: string } {
  if (typeof rel !== "string" || !rel.trim()) return { ok: false, reason: "path is empty" }
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "")
  const parts = clean.split("/")
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) {
    return { ok: false, reason: `path not allowed: ${rel}` }
  }
  const ext = extensionOf(clean)
  if (!FRAGMENT_SERVED_TYPES[ext]) {
    return {
      ok: false,
      reason: `file type .${ext || "(none)"} is not allowed — use ${Object.keys(FRAGMENT_SERVED_TYPES).join(", ")}`,
    }
  }
  return { ok: true, parts }
}

// ─── Sanitizers: what the app does with a manifest value it does not trust ──────────

/** A lucide name in kebab-case, or the default — an agent's guess never poisons the manifest. */
export function sanitizeFragmentIcon(value: unknown): string {
  if (typeof value !== "string") return FRAGMENT_DEFAULT_ICON
  const name = value.trim().toLowerCase()
  return name.length <= FRAGMENT_MAX_ICON_LENGTH && FRAGMENT_ICON_PATTERN.test(name) ? name : FRAGMENT_DEFAULT_ICON
}

/**
 * The widgets a fragment declares, cleaned: an id the page can put in a URL, a name, and
 * at least one size it knows how to draw. Anything malformed is dropped instead of
 * failing the whole manifest — a fragment with a bad widget still works as a page.
 */
export function sanitizeFragmentWidgets(value: unknown): FragmentWidget[] {
  if (!Array.isArray(value)) return []
  const out: FragmentWidget[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const raw = entry as Record<string, unknown>
    const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : ""
    if (!FRAGMENT_WIDGET_ID_PATTERN.test(id) || seen.has(id)) continue
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : ""
    if (!name) continue
    const declared = Array.isArray(raw.sizes) ? raw.sizes : []
    const sizes = FRAGMENT_WIDGET_SIZES.filter((size) => declared.includes(size))
    if (sizes.length === 0) continue
    seen.add(id)
    const widget: FragmentWidget = { id, name, sizes: [...sizes] }
    if (typeof raw.destination === "string" && raw.destination.trim()) {
      widget.destination = raw.destination.trim().slice(0, 200)
    }
    if (typeof raw.description === "string" && raw.description.trim()) {
      widget.description = raw.description.trim().slice(0, 120)
    }
    out.push(widget)
    if (out.length >= FRAGMENT_MAX_WIDGETS) break
  }
  return out
}

/** A new fragment is pinned where its kind lives; an old manifest without pins gets the same. */
export function defaultFragmentPins(kind: FragmentKind): FragmentPins {
  return { sidebar: kind === "screen", panel: kind === "panel" }
}

export function sanitizeFragmentPins(value: unknown, kind: FragmentKind): FragmentPins {
  const base = defaultFragmentPins(kind)
  if (!value || typeof value !== "object") return base
  const raw = value as Partial<FragmentPins>
  return {
    sidebar: typeof raw.sidebar === "boolean" ? raw.sidebar : base.sidebar,
    panel: typeof raw.panel === "boolean" ? raw.panel : base.panel,
  }
}

export function sanitizeFragmentModel(value: unknown): FragmentModel | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Partial<FragmentModel>
  if (typeof raw.providerId !== "string" || typeof raw.modelId !== "string") return undefined
  if (!raw.providerId || !raw.modelId) return undefined
  return { providerId: raw.providerId.slice(0, 120), modelId: raw.modelId.slice(0, 200) }
}

export function sanitizeFragmentReasoning(value: unknown): FragmentReasoning | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Partial<FragmentReasoning>
  if (raw.enabled !== true) return undefined
  const variantId =
    typeof raw.variantId === "string" && /^[a-z0-9_-]{1,40}$/i.test(raw.variantId) ? raw.variantId : undefined
  return { enabled: true, ...(variantId ? { variantId } : {}) }
}

export function sanitizeFragmentCaps(value: unknown): FragmentCapability[] {
  if (!Array.isArray(value)) return []
  return FRAGMENT_CAPABILITIES.filter((c) => value.includes(c))
}

// ─── Validation: the same rules, reported instead of silently repaired ──────────────

export interface FragmentIssue {
  severity: "error" | "warning"
  /** Where: `manifest.json` field or `src/` file. */
  where: string
  message: string
}

const MANIFEST_KEYS = new Set([
  "id",
  "name",
  "icon",
  "kind",
  "pinned",
  "model",
  "reasoning",
  "sdk",
  "requests",
  "grants",
  "revision",
  "createdAt",
  "updatedAt",
  "sessionId",
])

/**
 * Checks a manifest that is about to be handed to the app. The app repairs bad values on
 * read; a package author should hear about them instead. `grants` is the user's decision
 * and can never travel inside a package.
 */
export function validateFragmentManifest(raw: unknown): FragmentIssue[] {
  const issues: FragmentIssue[] = []
  const error = (where: string, message: string) => issues.push({ severity: "error", where, message })
  const warning = (where: string, message: string) => issues.push({ severity: "warning", where, message })

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    error("manifest.json", "must be a JSON object")
    return issues
  }
  const m = raw as Record<string, unknown>

  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(key)) warning(`manifest.${key}`, "unknown field, the app ignores it")
  }

  if (typeof m.name !== "string" || !m.name.trim()) error("manifest.name", "is required and must be a non-empty string")
  else if (m.name.trim().length > FRAGMENT_MAX_NAME_LENGTH) {
    error("manifest.name", `must be at most ${FRAGMENT_MAX_NAME_LENGTH} characters`)
  }

  if (m.id !== undefined && !isFragmentId(m.id)) {
    error("manifest.id", "must be lowercase letters, digits and hyphens (3–48 characters), e.g. frag-notes-1a2b3c")
  }

  if (m.icon !== undefined) {
    const icon = typeof m.icon === "string" ? m.icon.trim() : ""
    if (!icon || icon.length > FRAGMENT_MAX_ICON_LENGTH || !FRAGMENT_ICON_PATTERN.test(icon)) {
      error("manifest.icon", `must be a lucide icon name in kebab-case, e.g. "chart-bar" (otherwise "${FRAGMENT_DEFAULT_ICON}" is used)`)
    }
  }

  if (m.kind !== undefined && !FRAGMENT_KINDS.includes(m.kind as FragmentKind)) {
    error("manifest.kind", `must be one of: ${FRAGMENT_KINDS.join(", ")}`)
  }

  if (m.pinned !== undefined) {
    if (!m.pinned || typeof m.pinned !== "object" || Array.isArray(m.pinned)) {
      error("manifest.pinned", "must be an object with boolean sidebar and panel")
    } else {
      for (const [key, value] of Object.entries(m.pinned)) {
        if (key !== "sidebar" && key !== "panel") warning(`manifest.pinned.${key}`, "unknown pin, the app ignores it")
        else if (typeof value !== "boolean") error(`manifest.pinned.${key}`, "must be true or false")
      }
    }
  }

  if (m.model !== undefined && sanitizeFragmentModel(m.model) === undefined) {
    error("manifest.model", "must be { providerId: string, modelId: string } with both non-empty")
  }

  if (m.reasoning !== undefined) {
    const r = m.reasoning as Partial<FragmentReasoning> | null
    if (!r || typeof r !== "object" || typeof r.enabled !== "boolean") {
      error("manifest.reasoning", "must be { enabled: boolean, variantId?: string }")
    } else if (r.variantId !== undefined && sanitizeFragmentReasoning({ enabled: true, variantId: r.variantId })?.variantId === undefined) {
      error("manifest.reasoning.variantId", "must be 1–40 letters, digits, hyphens or underscores")
    }
  }

  if (m.sdk === undefined) error("manifest.sdk", `is required; this tooling supports sdk ${FRAGMENT_SDK_VERSION}`)
  else if (m.sdk !== FRAGMENT_SDK_VERSION) {
    error("manifest.sdk", `is ${JSON.stringify(m.sdk)} but this tooling supports sdk ${FRAGMENT_SDK_VERSION}`)
  }

  if (m.requests !== undefined) {
    if (!Array.isArray(m.requests)) error("manifest.requests", "must be an array of capabilities")
    else {
      for (const cap of m.requests) {
        if (!FRAGMENT_CAPABILITIES.includes(cap as FragmentCapability)) {
          error("manifest.requests", `unknown capability ${JSON.stringify(cap)} — known: ${FRAGMENT_CAPABILITIES.join(", ")}`)
        }
      }
      if (new Set(m.requests).size !== m.requests.length) warning("manifest.requests", "lists a capability more than once")
    }
  }

  if (m.grants !== undefined && !(Array.isArray(m.grants) && m.grants.length === 0)) {
    error("manifest.grants", "must be empty or absent: only the person using the fragment grants capabilities")
  }

  return issues
}

/** One file of `src/` as the validator sees it. */
export interface FragmentFileInfo {
  /** Relative to `src/`, forward slashes. */
  path: string
  bytes: number
}

/** Checks the `src/` listing against the rules the app applies when it writes and serves files. */
export function validateFragmentFiles(files: readonly FragmentFileInfo[]): FragmentIssue[] {
  const issues: FragmentIssue[] = []
  const servable: FragmentFileInfo[] = []

  for (const file of files) {
    const where = `src/${file.path}`
    const parts = file.path.split("/")
    // Dotfiles are skipped by the app's file listing: harmless, but never part of the fragment.
    if (parts.some((p) => p.startsWith("."))) {
      issues.push({ severity: "warning", where, message: "hidden files are ignored by the app" })
      continue
    }
    const checked = checkFragmentSrcPath(file.path)
    if (!checked.ok) {
      issues.push({ severity: "error", where, message: checked.reason })
      continue
    }
    if (file.bytes > FRAGMENT_MAX_FILE_BYTES) {
      issues.push({ severity: "error", where, message: `too large (limit ${Math.round(FRAGMENT_MAX_FILE_BYTES / 1024)}KB)` })
    }
    servable.push(file)
  }

  if (servable.length > FRAGMENT_MAX_FILES) {
    issues.push({ severity: "error", where: "src/", message: `too many files (${servable.length}, limit ${FRAGMENT_MAX_FILES})` })
  }
  if (!servable.some((f) => f.path === FRAGMENT_ENTRY)) {
    issues.push({ severity: "error", where: `src/${FRAGMENT_ENTRY}`, message: "the entry document is missing" })
  }
  return issues
}
