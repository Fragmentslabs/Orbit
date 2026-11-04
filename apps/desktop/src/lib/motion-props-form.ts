/**
 * The form of a composition's props (props.json) in the Motion tab: what each input holds, which
 * values are valid, and what goes to the preview and to the render. Pure, so it is tested without a DOM.
 *
 * The rules mirror main's electron/lib/video/motion-props.ts (the renderer cannot import it): main
 * checks again before rendering, this only keeps the person from sending what would be refused.
 */

export type MotionPropType = "text" | "number" | "color" | "boolean" | "select" | "image"

/** Mirror of main's PropDef. */
export interface MotionPropDef {
  type: MotionPropType
  default: string | number | boolean
  label?: string
  min?: number
  max?: number
  options?: string[]
}

/** Mirror of what `motion:props` answers. */
export interface MotionPropsInfo {
  exists: boolean
  schema: Record<string, MotionPropDef>
  errors: string[]
}

/** What the inputs hold: text for everything, a boolean for the switches. */
export type PropFormValues = Record<string, string | boolean>
export type PropOverrides = Record<string, string | number | boolean>

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** The default of each prop, as an input holds it. */
export function defaultValues(schema: Record<string, MotionPropDef>): PropFormValues {
  const out: PropFormValues = {}
  for (const [name, def] of Object.entries(schema)) out[name] = def.type === "boolean" ? Boolean(def.default) : String(def.default)
  return out
}

/** Why a raw value is not acceptable, or null. A number accepts the decimal comma; empty text is fine. */
export function fieldError(def: MotionPropDef, raw: string | boolean): string | null {
  if (def.type === "boolean") return null
  const text = String(raw)
  switch (def.type) {
    case "text":
      return null
    case "number": {
      if (text.trim() === "") return "required"
      const n = Number(text.replace(",", "."))
      if (!Number.isFinite(n)) return "number"
      if (def.min !== undefined && n < def.min) return `min:${def.min}`
      if (def.max !== undefined && n > def.max) return `max:${def.max}`
      return null
    }
    case "color":
      return COLOR.test(text) ? null : "color"
    case "select":
      return def.options?.includes(text) ? null : "select"
    case "image":
      return isSafeRelative(text) ? null : "path"
  }
}

function isSafeRelative(p: string): boolean {
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("/") || p.startsWith("\\")) return false
  return !p.replace(/\\/g, "/").split("/").includes("..")
}

/**
 * What differs from the defaults AND is valid: that is what the preview and the render receive. An invalid
 * field is reported in `errors` (by name) and left out, so the preview keeps showing the last good state
 * while the person is still typing.
 */
export function toOverrides(
  schema: Record<string, MotionPropDef>,
  values: PropFormValues,
): { overrides: PropOverrides; errors: Record<string, string> } {
  const overrides: PropOverrides = {}
  const errors: Record<string, string> = {}
  for (const [name, def] of Object.entries(schema)) {
    const raw = values[name]
    if (raw === undefined) continue
    const error = fieldError(def, raw)
    if (error) {
      errors[name] = error
      continue
    }
    const value: string | number | boolean = def.type === "boolean" ? Boolean(raw) : def.type === "number" ? Number(String(raw).replace(",", ".")) : String(raw)
    if (value !== def.default) overrides[name] = value
  }
  return { overrides, errors }
}

/** base64url of the JSON (UTF-8), the same transport main decodes (PROPS_QUERY). */
export function encodeOverrides(overrides: PropOverrides): string {
  const bytes = new TextEncoder().encode(JSON.stringify(overrides))
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Name of the query parameter the scheme handler reads (main's PROPS_QUERY). */
export const MOTION_PROPS_QUERY = "orbitProps"

/** The preview URL with the overrides, or the URL as it is when nothing differs from the defaults. */
export function srcWithProps(src: string, overrides: PropOverrides): string {
  if (!src || !Object.keys(overrides).length) return src
  return `${src}${src.includes("?") ? "&" : "?"}${MOTION_PROPS_QUERY}=${encodeOverrides(overrides)}`
}

/** How many props differ from the defaults (the badge on the button). */
export function changedCount(overrides: PropOverrides): number {
  return Object.keys(overrides).length
}
