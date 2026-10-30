import type { SendMessageOptions, SessionMode } from "./chat"

export type SlashActionKind = "pipeline" | "insert" | "init"

export interface SlashActionSpec {
  id: string
  command: string
  /** Shown by the palette as it is — pt-BR UI copy (the palette has no i18n key for it). */
  description: string
  /** How the user calls it, in pt and en — it is what links the typed text to the action. */
  keywords: string[]
  modes: SessionMode[]
  kind: SlashActionKind
  insertText?: string
  buildPrompt?: (input: string) => string
  options?: Partial<SendMessageOptions>
}

const target = (input: string, fallback: string) => (input.trim() ? input.trim() : fallback)

export const SLASH_ACTIONS: SlashActionSpec[] = [
  {
    id: "code-review",
    command: "/code-review",
    description: "Reviews the current diff (or a target): critical points → suggestions → applies the approved ones",
    keywords: ["review", "revisao", "pr", "diff"],
    modes: ["code"],
    kind: "pipeline",
    buildPrompt: (input) => `Do a complete code review following this pipeline:

1. **Gather the target**: ${target(input, "run `git diff` (and `git diff --staged`) in the project folder; if there are no changes, use `git show HEAD`")}
2. **Analyze the critical points**: bugs, edge cases, security, performance, readability and adherence to the project's conventions (check the project memory if available).
3. **Report**: list the findings by severity (critical / important / suggestion), each with file:line and a short explanation.
4. **Confirm**: use the question tool to ask WHICH fixes I should apply.
5. **Apply** only the approved ones and show a summary of what changed.`,
  },
  {
    id: "refactor",
    command: "/refactor",
    description: "Analyzes structure → proposes an improvement → executes with validation (tests + typecheck)",
    keywords: ["refatorar", "refactor", "melhorar codigo"],
    modes: ["code"],
    kind: "pipeline",
    buildPrompt: (input) => `Refactor with validation, following this pipeline:

1. **Target**: ${target(input, "identify from the conversation/context the file or module to refactor; if ambiguous, ask")}
2. **Analyze** the current structure: responsibilities, duplication, coupling, names.
3. **Propose** the refactor (what changes, why, risks) and WAIT for my confirmation through the question tool before touching any file.
4. **Execute** the approved refactor in small steps.
5. **Validate**: run typecheck and the project's tests (find the commands in package.json/scripts or equivalent). If something breaks, fix it before finishing.
6. **Summarize** what changed and the validation result.`,
  },
  {
    id: "improve-ui",
    command: "/improve-ui",
    description: "Analyzes accessibility, responsiveness and consistency with the design system",
    keywords: ["ui", "interface", "design", "acessibilidade", "a11y"],
    modes: ["code"],
    kind: "pipeline",
    buildPrompt: (input) => `Improve the interface following this pipeline:

1. **Target**: ${target(input, "identify the component/screen from the conversation; if ambiguous, ask")}
2. **Analyze** along three axes:
   - Accessibility: semantics, focus, contrast, aria, keyboard navigation
   - Responsiveness: behavior at small widths, overflow, truncation
   - Consistency: compare with the design system / existing ui components of the project (check the project's design memory if available)
3. **Suggest** the changes in a prioritized list, with a code snippet for each one.
4. **Ask** through the question tool which ones to apply, and apply the approved ones.`,
  },
  {
    id: "explain",
    command: "/explain",
    description: "Explains a piece of code with the project's context",
    keywords: ["explicar", "explain", "entender", "codigo"],
    modes: ["chat", "code"],
    kind: "pipeline",
    buildPrompt: (input) => `Explain the following with context:

${target(input, "(paste the code snippet or point to file:lines)")}

Structure the explanation as: what it does (overview) → how it works (step by step) → why it exists (its role in the project, if identifiable from the context/memory) → points of attention.`,
  },
  {
    id: "debug",
    command: "/debug",
    description: "Analyzes an error log / stack trace → root cause → suggests or applies a fix",
    keywords: ["debug", "erro", "stack", "trace", "bug"],
    modes: ["code"],
    kind: "pipeline",
    buildPrompt: (input) => `Debug this problem following the pipeline:

${target(input, "(paste the error log or stack trace)")}

1. **Interpret** the error: what it says literally and where it happens.
2. **Investigate** the root cause in the code (read the files involved — do not stop at the symptom).
3. **Explain** the root cause in 2-3 sentences.
4. **Fix**: propose the fix and, before applying any change, confirm with me through the question tool. After applying, validate (typecheck/relevant test).`,
  },
  {
    id: "search-memory",
    command: "/search-memory",
    description: "Text search in the memories (Brain) before answering",
    keywords: ["lembrar", "memoria", "brain", "recall", "buscar"],
    modes: ["chat", "code"],
    kind: "pipeline",
    buildPrompt: (input) => `Search the project memories (Brain) for what is relevant to: ${target(input, "list every available memory and its summary")}

Use the memories found to answer in detail, citing the sources. If the search finds nothing relevant, tell the user and suggest creating a memory about the subject.`,
  },
  {
    id: "init",
    command: "/init",
    description: "Analyzes the project and generates/extends memories by area (stack, architecture, design…)",
    keywords: ["init", "analisar projeto", "scan", "onboarding"],
    modes: ["code"],
    kind: "init",
  },
  {
    id: "init-force",
    command: "/init-force",
    description: "Re-analyzes the project from scratch and overwrites the existing memories",
    keywords: ["init-force", "force", "reanalisar", "sobrescrever"],
    modes: ["code"],
    kind: "init",
  },
]

export function actionsForMode(mode: SessionMode): SlashActionSpec[] {
  return SLASH_ACTIONS.filter((a) => a.modes.includes(mode))
}

export const SLASH_ACTION_COMMANDS = SLASH_ACTIONS.map((a) => a.command)

export interface ResolvedSlashAction {
  action: SlashActionSpec
  input: string
  prompt?: string
}

export function resolveSlashAction(text: string, mode: SessionMode): ResolvedSlashAction | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null
  const candidates = actionsForMode(mode)
    .filter((a) => trimmed === a.command || trimmed.startsWith(a.command + " "))
    .sort((a, b) => b.command.length - a.command.length)
  const action = candidates[0]
  if (!action) return null
  const input = trimmed.slice(action.command.length).trim()
  return {
    action,
    input,
    prompt: action.kind === "pipeline" ? action.buildPrompt!(input) : undefined,
  }
}
