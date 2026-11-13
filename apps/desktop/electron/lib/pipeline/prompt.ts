import type { AgentDefinition } from '@shared/agents'

/**
 * The fixed half of a phase's system prompt — the part nobody edits.
 *
 * A phase is not a conversation: it runs alone, has nobody to answer it and is
 * judged by one note. Those rules belong to the engine, not to the person's
 * text, so they hold for the native phases, for the ones the person writes and
 * for the ones that will come. Without them a phase created from scratch (and
 * every phase running on "General") had no operating rule at all.
 *
 * Written in English like the rest of the app prompts (prompts.ts).
 */

/**
 * Precedence preamble injected BEFORE the phase prompt. It is what guarantees
 * that instructions in the task description (how to commit, whether to commit,
 * how to validate) beat what the phase prompt says by default — because the
 * phase prompt lives in `system`, which many models treat as stronger than the
 * user message. Without it, a "do not create a commit" in the description could
 * be run over by a "commit locally" from the template.
 *
 * What is NOT negotiable is the scope: the phase still does only its own job
 * (validation does not implement, dev does not push), whatever the description
 * asks. Description precedence applies to HOW to do the phase's own work, not
 * to WHAT each phase's work is.
 */
export const PRECEDENCE = `The task description in the user message is your PRIMARY brief and takes precedence over this phase prompt. Where the two conflict — including how to commit, whether to create a commit at all, or how to validate — follow the task description, not this prompt. This precedence does NOT change your scope: you still do only your phase's job as defined here, and never push or pull (nothing leaves this machine on its own).`

/**
 * Rules of the run itself. Always injected, before the phase's own text.
 *
 * `language` is the app's language (English name, e.g. "Portuguese"): the note
 * is what the next phase reads, so it is written in the person's language even
 * when the prompt that produced it is in English.
 */
export function phaseRules(language?: string): string {
  return `## How this phase runs
You are ONE phase of an automated pipeline. Nobody is watching while you work: there is no one to answer a question, approve a step or clarify a doubt.
- Decide with the tools you have and keep going. Never end the turn to ask, propose options or wait for a confirmation — a phase that ends without its note fails and runs again, paying twice.
- Do only your phase's job. The other phases are listed in the task message: leave their work to them, even when the task description asks for something that belongs to another phase.
- Work directly: open what the job needs, change what it needs, stop when it is done. Exploring the repository beyond that is paid by the next phase's time.
- Never claim work you did not do. If something could not be finished, say so plainly in the note and explain why.

## Language
- Write the note in ${language ?? 'the language of the task description'} — it is the only thing the next phase reads.
- Code, identifiers, comments and commit messages follow the project's conventions, not this rule.`
}

/**
 * What the tools of THIS phase require, read from the tools that actually
 * exist after the capabilities are applied — a guide for a tool that is not
 * there would only make the model look for it.
 */
export function toolRules(names: ReadonlySet<string>): string[] {
  const rules: string[] = []
  if (names.has('code_search')) {
    rules.push(
      '- Locate code with code_search / code_outline / code_refs before opening files, and open a file before editing it.',
    )
  }
  if (names.has('write') || names.has('edit')) {
    rules.push('- Change files with edit/write, never with sed, tee or a redirect in the shell.')
  }
  if (names.has('verify_changes')) {
    rules.push(
      '- After changing files, call verify_changes before writing the note. A claim the tool does not confirm does not go in the note.',
    )
  }
  if (names.has('bash')) {
    rules.push(
      '- Shell commands run with nobody to approve: irreversible or outbound ones (push, publish, install, curl) are blocked or recorded by the command policy. If a command is refused, do not route around it — report it.',
    )
  }
  if (names.has('run_tools')) {
    rules.push('- run_tools runs one script that calls many tools: prefer it over repeating the same call N times.')
  }
  if (names.has('panel_navigate')) {
    rules.push(
      '- Checking a web app: panel_navigate → panel_read → panel_click/panel_type; panel_console when a page renders blank or an action does nothing; panel_resize for the mobile and tablet sizes.',
    )
  }
  if (names.has('websearch')) {
    rules.push(
      '- Web research: search with websearch, open the page with webfetch before trusting it, and cite the URL in the note.',
    )
  }
  if (names.has('memory_search')) {
    rules.push(
      '- The project memories are a starting point, not the truth: search them before re-deriving what the project already knows; save only what a future phase would need.',
    )
  }
  return rules
}

/**
 * The catalog of tool families, when the phase's tool set has one. Without it
 * the model never calls tools_load — the family stays a list it cannot use.
 */
export function toolCatalogRules(map: string): string {
  return `The tools that are not loaded yet are grouped in families, one line each. Load a family with tools_load — the result carries its guide, read it before the first call — then call the real tool in the next step. tools_list shows a family's tool names without loading it. Never replace a family tool with bash or the browser, and never insist on a disabled one: say why in the note.
${map}`
}

/** The tool guidance as one section, heading included (empty when there is none). */
export function toolSection(names: ReadonlySet<string>, map?: string): string {
  const lines = [...toolRules(names)]
  if (map) lines.push('', toolCatalogRules(map))
  return lines.length > 0 ? `## Using the tools\n${lines.join('\n')}` : ''
}

/**
 * What THIS phase's note must record — the phase's half of the note rule.
 * The format and the failure condition stay in the engine's contract; here the
 * template (or the person) says only which facts the next phase needs.
 */
export function noteSection(noteContract?: string): string {
  const text = noteContract?.trim()
  return text ? `## What the note records\n${text}` : ''
}

/**
 * The specialist running the phase: its prompt is HOW the work is done, not
 * WHAT the phase does. Stated in the text because the agent's prompt sits
 * before the phase's own, and a "you are a designer" would otherwise read as
 * the job.
 */
export function specialistIdentity(agent: Pick<AgentDefinition, 'name' | 'prompt'>): string {
  const prompt = agent.prompt.trim()
  if (!prompt) return ''
  return `## Specialist identity — ${agent.name}
${prompt}

That identity is HOW you work. WHAT this phase does is defined below — the phase instructions win whenever the two disagree.`
}

export interface PhasePromptInput {
  /** App language, English name (e.g. "Portuguese"). */
  language?: string
  /** Names of the tools that exist in this phase. */
  tools: ReadonlySet<string>
  /** Catalog map of the tool families, when the set has one. */
  toolMap?: string
  /** Lines of the brain block, when the phase works with memories. */
  memories?: readonly string[]
  /** The specialist running the phase ("General" = none). */
  specialist?: Pick<AgentDefinition, 'name' | 'prompt'>
  /** The phase's own instructions (a template's or the person's). */
  instructions: string
  /** What this phase's note must record (a template's or the person's). */
  noteContract?: string
  /** The note rule — always last, always the engine's. */
  contract: string
}

/**
 * The whole system prompt of a phase, in the order it is sent:
 *
 *   precedence → how the run works → the tools → memories → specialist →
 *   the phase's instructions → what the note records → the note rule.
 *
 * Everything above the phase's instructions is the engine's and cannot be
 * removed by editing a phase; everything below is what the person writes. That
 * split is what keeps a phase created from scratch behaving like a native one.
 */
export function phaseSystemPrompt(input: PhasePromptInput): string {
  return [
    PRECEDENCE,
    phaseRules(input.language),
    toolSection(input.tools, input.toolMap),
    ...(input.memories ?? []),
    input.specialist ? specialistIdentity(input.specialist) : '',
    input.instructions,
    noteSection(input.noteContract),
    input.contract,
  ]
    .filter(Boolean)
    .join('\n\n')
}
