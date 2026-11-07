/**
 * Fields of a ready-made message: the parts in [square brackets] the person is meant to
 * replace ("Create a slide deck about [topic]"). The composer selects the first one when a
 * template is put in and Tab jumps to the next, so completing a template never needs the mouse.
 */

const FIELD = /\[[^[\]\n]+\]/g

export interface FieldRange {
  start: number
  end: number
}

/** The first field that starts at or after `from`, or null when there is none left. */
export function nextTemplateField(text: string, from = 0): FieldRange | null {
  FIELD.lastIndex = Math.max(0, from)
  const match = FIELD.exec(text)
  return match ? { start: match.index, end: match.index + match[0].length } : null
}

export function hasTemplateField(text: string): boolean {
  return nextTemplateField(text) !== null
}

/**
 * The fields that are walked with Tab belong to a template that was put in the input, not to
 * any "[text]" the person types (a Markdown link, a checklist): only an input marked here
 * captures the key, and it stops being marked once it is emptied (the message was sent).
 */
const templateInputs = new WeakSet<HTMLTextAreaElement>()

/** Puts the template's first field in selection and arms Tab for the others. */
export function armTemplateInput(node: HTMLTextAreaElement): void {
  const first = nextTemplateField(node.value)
  if (!first) return
  templateInputs.add(node)
  node.focus()
  node.setSelectionRange(first.start, first.end)
}

/** Gives Tab back to the browser (the person dismissed the template's badge). */
export function disarmTemplateInput(node: HTMLTextAreaElement): void {
  templateInputs.delete(node)
}

/** The next field after the caret, only for an armed input that still has text. */
export function nextArmedField(node: HTMLTextAreaElement): FieldRange | null {
  if (!templateInputs.has(node)) return null
  if (node.value === "") {
    templateInputs.delete(node)
    return null
  }
  return nextTemplateField(node.value, node.selectionEnd)
}
