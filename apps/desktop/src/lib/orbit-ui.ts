import { z } from "zod"

/**
 * Contrato dos blocos inline que o assistente desenha no meio da resposta
 * (fence ```orbit-ui).
 *
 * O formato é JSON Lines — um componente por linha — e não um array: uma linha
 * completa já é um componente completo, então a tela consegue desenhar cada
 * peça assim que ela termina de chegar, enquanto o modelo ainda escreve a
 * próxima. Com um array único, nada seria válido até o colchete final.
 *
 * O modelo escolhe entre componentes NOSSOS (catálogo fechado): nunca manda
 * código, só dados. O visual vem inteiro do design system do Orbit, e uma linha
 * inválida é descartada em vez de quebrar a resposta.
 *
 * Interatividade é declarativa, e também só dados: componentes de entrada
 * (slider, select…) têm um `id` e guardam um valor; qualquer texto pode
 * referenciar esses ids com `{expr}` e números aceitam expressões (ver
 * orbit-expr.ts); `showIf` mostra/esconde um bloco; botões enviam uma
 * mensagem, copiam um texto ou mudam um valor.
 */

const text = (max: number) => z.string().max(max)
/** Número ou texto; sai sempre como texto, que é o que a tela imprime. */
const cell = z.union([z.string().max(300), z.number()]).transform(String)

/** Id de um valor interativo — também é o nome da variável nas expressões. */
const inputId = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/)
/** Número, ou expressão que resulta em número (`"=capital*2"`). */
const numExpr = z.union([z.number(), z.string().max(200)])
const option = z.union([
  z.string().max(60).transform((label) => ({ label, value: label as string | number })),
  z.object({ label: text(60), value: z.union([z.string().max(60), z.number()]) }),
])
/** Mostra o bloco só quando a expressão é verdadeira (abas, cenários). */
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
  /** Expressão em `x` (e nos ids interativos): `capital*(1+juros/100)^x`. */
  fn: z.string().max(200),
})

const chart = z
  .object({
    type: z.literal("chart"),
    kind: z.enum(["bar", "line", "area", "pie"]).default("bar"),
    title: text(100).optional(),
    unit: text(12).optional(),
    /** Pontos prontos; o valor pode ser uma expressão sobre os ids interativos. */
    data: z.array(z.object({ label: text(40), value: numExpr })).min(1).max(24).optional(),
    /** Ou: uma ou mais funções amostradas de x[0] a x[1]. */
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
        /** send: manda `text` como mensagem do usuário; copy: copia `text`; set: grava `value` em `id`. */
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

/** Os tipos que guardam um valor e entram no escopo das expressões. */
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
])

export type OrbitUiBlock = z.infer<typeof orbitUiBlock>

export type OrbitUiParse = {
  blocks: OrbitUiBlock[]
  /** Há uma linha ainda chegando — a tela mostra um esqueleto no lugar dela. */
  pending: boolean
}

function parseLine(line: string): OrbitUiBlock | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = orbitUiBlock.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Lê o conteúdo do fence. Linha completa e válida vira bloco; inválida é
 * descartada. A ÚLTIMA linha de um fence ainda aberto pode estar pela metade:
 * se ainda não fecha como JSON válido, é `pending`, não erro.
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
