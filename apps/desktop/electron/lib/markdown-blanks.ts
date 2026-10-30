/**
 * Fill-in fields that vanish in the preview.
 *
 * `____/____/______` does not reach the screen whole: in Markdown, `__` is bold, and
 * two groups on the same line become an open-and-close. "Date: ____/____/______" is
 * rendered as "Date: //______" — the underscores are consumed as
 * markup and what is left is the slash. It is not an Orbit bug nor the renderer's: it is
 * the rule of the language, and it holds the same in the PDF and the DOCX, which come out of the same
 * Markdown.
 *
 * A group on its own (`**School:** ____________`) passes intact, because there is no
 * second group to close the emphasis. That is why the warning is about the LINE with
 * more than one group, and not about underscore in general.
 *
 * The document is written the same way: whoever wrote it was the agent, and rewriting
 * its text on our own would be deciding in place of whoever asked. What
 * comes back is the warning, with the line and the fix — which is what the model reads and
 * fixes in the following call.
 */

/** Two or more groups of underscores separated only by punctuation: the face of a
 *  date, phone or tax-id field. Text between the groups (real `__bold__`) has
 *  letters, and does not enter here. */
const BROKEN_FIELD = /_{2,}[^\w\s_]+_{2,}/u

export function underscoreBlankWarning(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/)
  const affected: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (BROKEN_FIELD.test(lines[i])) affected.push(i + 1)
  }
  if (affected.length === 0) return null

  const where =
    affected.length === 1
      ? `line ${affected[0]} has`
      : `lines ${affected.slice(0, 5).join(', ')}${affected.length > 5 ? '…' : ''} have`
  return (
    `Warning: ${where} fields like "____/____/____", and in Markdown two groups of ` +
    'underscores become bold — on SCREEN (the chat reply and the document panel) the user ' +
    'sees "//" instead of the field. In the PDF and DOCX it comes out right, but the document is read in ' +
    'both places. Write "\\_\\_\\_\\_/\\_\\_\\_\\_/\\_\\_\\_\\_" (escaped, which works ' +
    'everywhere) or separate with spaces ("____ / ____ / ____"), and call update_document again.'
  )
}
