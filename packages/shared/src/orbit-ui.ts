import { z } from "zod"

/**
 * Contract of the inline blocks the assistant draws in the middle of the answer
 * (```orbit-ui fence).
 *
 * The format is JSON Lines — one component per line — and not an array: one
 * complete line is already a complete component, so the screen can draw each
 * piece as soon as it finishes arriving, while the model still writes the
 * next one. With a single array, nothing would be valid until the final bracket.
 *
 * The model chooses among OUR components (closed catalog): it never sends
 * code, only data. The visuals come entirely from the Orbit design system, and an invalid
 * line is discarded instead of breaking the answer.
 *
 * Interactivity is declarative, and also data only: input components
 * (slider, select…) have an `id` and store a value; any text can
 * reference those ids with `{expr}` and numbers accept expressions (see
 * orbit-expr.ts); `showIf` shows/hides a block; buttons send a
 * message, copy a text or change a value. The `nav` card leads to a screen
 * of the app itself — whoever clicks is the user, and nothing opens on its own.
 */

const text = (max: number) => z.string().max(max)
/** Number or text; it always comes out as text, which is what the screen prints. */
const cell = z.union([z.string().max(300), z.number()]).transform(String)

/** Id of an interactive value — it is also the variable name in the expressions. */
const inputId = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/)
/** Number, or expression that results in a number (`"=capital*2"`). */
const numExpr = z.union([z.number(), z.string().max(200)])
const option = z.union([
  z.string().max(60).transform((label) => ({ label, value: label as string | number })),
  z.object({ label: text(60), value: z.union([z.string().max(60), z.number()]) }),
])
/** Shows the block only when the expression is true (tabs, scenarios). */
const showIf = { showIf: z.string().max(200).optional() }

const stats = z.object({
  type: z.literal("stats"),
  items: z
    .array(
      z.object({
        label: text(60),
        value: cell,
        delta: text(30).optional(),
        trend: z.enum(["up", "down", "flat"]).optional(),
        hint: text(120).optional(),
      }),
    )
    .min(1)
    .max(6),
})

const callout = z.object({
  type: z.literal("callout"),
  tone: z.enum(["info", "success", "warning", "danger"]).default("info"),
  title: text(80).optional(),
  text: text(600),
})

const steps = z.object({
  type: z.literal("steps"),
  items: z
    .array(
      z.object({
        title: text(100),
        text: text(400).optional(),
        status: z.enum(["done", "active", "todo"]).optional(),
      }),
    )
    .min(1)
    .max(12),
})

const table = z.object({
  type: z.literal("table"),
  columns: z.array(text(60)).min(1).max(8),
  rows: z.array(z.array(cell).max(8)).min(1).max(30),
})

const chartFn = z.object({
  name: text(40).optional(),
  /** Expression in `x` (and in the interactive ids): `capital*(1+rate/100)^x`. */
  fn: z.string().max(200),
})

const chart = z
  .object({
    type: z.literal("chart"),
    kind: z.enum(["bar", "line", "area", "pie"]).default("bar"),
    title: text(100).optional(),
    unit: text(12).optional(),
    /** Ready points; the value can be an expression over the interactive ids. */
    data: z.array(z.object({ label: text(40), value: numExpr })).min(1).max(24).optional(),
    /** Or: one or more functions sampled from x[0] to x[1]. */
    fns: z.array(chartFn).min(1).max(4).optional(),
    x: z.tuple([z.number(), z.number()]).optional(),
    steps: z.number().int().min(2).max(120).optional(),
    xLabel: text(30).optional(),
  })
  .refine((c) => c.data || (c.fns && c.x), "chart needs data, or fns with x")

const checklist = z.object({
  type: z.literal("checklist"),
  items: z.array(z.object({ text: text(200), done: z.boolean().optional() })).min(1).max(20),
})

const compare = z.object({
  type: z.literal("compare"),
  items: z
    .array(
      z.object({
        title: text(60),
        tag: text(30).optional(),
        points: z.array(text(200)).min(1).max(8),
      }),
    )
    .min(2)
    .max(4),
})

const keyvalue = z.object({
  type: z.literal("kv"),
  items: z.array(z.object({ label: text(60), value: cell })).min(1).max(16),
})

const progress = z.object({
  type: z.literal("progress"),
  items: z
    .array(
      z.object({
        label: text(80),
        value: numExpr,
        hint: text(80).optional(),
      }),
    )
    .min(1)
    .max(10),
})

const slider = z.object({
  type: z.literal("slider"),
  id: inputId,
  label: text(60),
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
  value: z.number().optional(),
  unit: text(12).optional(),
})

const numberInput = z.object({
  type: z.literal("number"),
  id: inputId,
  label: text(60),
  value: z.number().default(0),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  unit: text(12).optional(),
})

const select = z.object({
  type: z.literal("select"),
  id: inputId,
  label: text(60).optional(),
  options: z.array(option).min(1).max(12),
  value: z.union([z.string().max(60), z.number()]).optional(),
})

const tabs = z.object({
  type: z.literal("tabs"),
  id: inputId,
  options: z.array(option).min(2).max(6),
  value: z.union([z.string().max(60), z.number()]).optional(),
})

const toggle = z.object({
  type: z.literal("toggle"),
  id: inputId,
  label: text(80),
  value: z.boolean().optional(),
})

const textInput = z.object({
  type: z.literal("text"),
  id: inputId,
  label: text(60).optional(),
  placeholder: text(80).optional(),
  value: text(200).optional(),
})

const buttons = z.object({
  type: z.literal("buttons"),
  items: z
    .array(
      z.object({
        label: text(60),
        /** send: sends `text` as a user message; copy: copies `text`; set: writes `value` into `id`. */
        action: z.enum(["send", "copy", "set"]),
        text: text(600).optional(),
        id: inputId.optional(),
        value: z.union([z.string().max(60), z.number(), z.boolean()]).optional(),
        variant: z.enum(["primary", "outline"]).optional(),
      }),
    )
    .min(1)
    .max(6),
})

/**
 * Invitation to a screen of the app ("where is this?").
 *
 * The model sends only the `destination` — an id from the shared registry
 * (@shared/ui-destinations) —, never the hand-written path: the label comes from the
 * same i18n keys the screen uses. An unknown destination does not become a card, and a
 * screen that does not exist on the surface becomes an explanation, not a dead button.
 */
const nav = z.object({
  type: z.literal("nav"),
  destination: z.string().max(40),
  /** One line saying what is solved there. */
  note: text(160).optional(),
})

/** The types that store a value and enter the scope of the expressions. */
export const INPUT_TYPES = ["slider", "number", "select", "tabs", "toggle", "text"] as const

export const orbitUiBlock = z.discriminatedUnion("type", [
  stats.extend(showIf),
  callout.extend(showIf),
  steps.extend(showIf),
  table.extend(showIf),
  chart.safeExtend(showIf),
  checklist.extend(showIf),
  compare.extend(showIf),
  keyvalue.extend(showIf),
  progress.extend(showIf),
  slider.extend(showIf),
  numberInput.extend(showIf),
  select.extend(showIf),
  tabs.extend(showIf),
  toggle.extend(showIf),
  textInput.extend(showIf),
  buttons.extend(showIf),
  nav.extend(showIf),
])

export type OrbitUiBlock = z.infer<typeof orbitUiBlock>

export type OrbitUiParse = {
  blocks: OrbitUiBlock[]
  /** There is a line still arriving — the screen shows a skeleton in its place. */
  pending: boolean
}

function parseLine(line: string): OrbitUiBlock | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  // `destino`/`nota` are the legacy field names of the nav block, kept in the history of
  // conversations written before the standard was English.
  if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "nav") {
    const nav = raw as Record<string, unknown>
    raw = { ...nav, destination: nav.destination ?? nav.destino, note: nav.note ?? nav.nota }
  }
  const parsed = orbitUiBlock.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Reads the content of the fence. A complete and valid line becomes a block; an invalid one is
 * discarded. The LAST line of a still open fence may be half written:
 * if it does not close as valid JSON yet, it is `pending`, not an error.
 */
export function parseOrbitUi(code: string, isIncomplete: boolean): OrbitUiParse {
  const lines = code.split("\n").map((line) => line.trim()).filter(Boolean)
  const blocks: OrbitUiBlock[] = []
  let pending = false
  lines.forEach((line, index) => {
    const block = parseLine(line)
    if (block) blocks.push(block)
    else if (isIncomplete && index === lines.length - 1) pending = true
  })
  return { blocks, pending }
}
