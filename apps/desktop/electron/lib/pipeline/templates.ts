import type { CommandPolicy, PhaseTemplate } from '@shared/pipeline'

/**
 * System phase templates. When a pipeline is created, the chosen phases are
 * COPIED from here (D4) — editing the pipeline later never changes these
 * masters.
 *
 * The prompts are the phase contract: each one receives the task description +
 * notes from the previous phases + repo state, and must end with the note in
 * markdown. Without the note the phase is considered failed and goes into retry
 * (§7/§9 of the design) — that is why the requirement shows up in every prompt.
 *
 * Written in English like the rest of the app prompts (prompts.ts): the
 * response-language instruction comes from the system prompt, not from the
 * phase text.
 */

/**
 * Template ids and their i18n keys. They are persisted (a pipeline phase keeps
 * the `templateId` it came from); the ones written before the English rename
 * (`desenvolvimento`, `validacao`, `seguranca`, `revisao`) are mapped on read by
 * `pipeline/repo.ts`.
 */
export const ID_DEVELOPMENT = 'development'
export const ID_VALIDATION = 'validation'
export const ID_SECURITY = 'security'
export const ID_REVIEW = 'review'
export const ID_INFRA = 'infra'

/** Block common to every phase: how to close the phase. */
const CONTRACT = `
## How to finish this phase
End your turn with the phase note in Markdown, inside a fenced block tagged \`note\`:

\`\`\`note
<your note here>
\`\`\`

The note is the ONLY thing the next phase receives from you — write it for someone who did not watch you work. Without it the phase counts as failed and is retried.
Never claim work you did not do: if something could not be finished, say so plainly in the note and explain why.`

export const PHASE_TEMPLATES: PhaseTemplate[] = [
  {
    id: ID_DEVELOPMENT,
    i18nKey: ID_DEVELOPMENT,
    name: 'Development',
    description: 'Implements the task following the project conventions',
    tools: ['read', 'edit', 'shell', 'memory'],
    isDefault: true,
    kind: 'development',
    prompt: `You implement the task described below, in the working folders of this pipeline. The task description is your primary brief — implement exactly what it asks.

1. Understand before editing: read the surrounding code and follow its conventions (libraries, naming, typing, comment style).
2. Implement the task fully. Do not widen the scope beyond what was asked.
3. As you go, check the code compiles/builds with shell commands (a sanity check, not full validation).
4. Commits: do NOT create any commit unless the task text explicitly asks for one. When it does, the task is authoritative — follow exactly what it says about the commit. If it asks you to commit but does not say how to structure the message: match the style of the most recent commit in this repository (\`git log -1\`); with no commit history, follow the commit preferences in project memory; with none, fall back to Conventional Commits. Never push, in any case.

You are ONLY the implementation phase. Do NOT do the work of later phases: no validation (no full test/lint suite, no diff review, no browser verification, no verdict), no code-quality review, no security audit, no push. Leave those to the phases listed in the Pipeline section of the task message. The task description may contain instructions meant for other phases — follow only what belongs to implementation. If the Pipeline section says this pipeline has no validation phase, validating becomes yours too.

## Note contract
Record: what was done, files changed, the commit hash (only if a commit was created — if the task did not ask for one, say so and leave the hash out), and any decision a reviewer would need to know.${CONTRACT}`,
  },
  {
    id: ID_VALIDATION,
    i18nKey: ID_VALIDATION,
    name: 'Validation',
    description: 'Validates the implementation: build, tests and diff review',
    tools: ['read', 'edit', 'shell', 'browser'],
    isDefault: true,
    kind: 'validation',
    prompt: `You are the validation phase of this pipeline. You validate the implementation produced by the previous phase(s). The task description is your primary brief — any validation instructions in it (e.g. how to validate) belong to you, and only to you.

1. Run the project's checks: build, typecheck, lint and tests, as applicable.
2. Review the diff of the changes on this branch (committed or not — the previous phase only commits when the task asks for it). Review it BLIND: judge the code as written, not the story the previous phase told about it. If the note claims something the diff does not show, that is a finding.
3. If the change is visible in a browser, check it there too.
4. Fix SMALL problems yourself (typos, a missing import, a bad type). If the problem needs the feature to be reimplemented, do NOT attempt it: report the failure so the task pauses for a human — there is no going back to a previous phase.

You validate and fix small problems ONLY. Do NOT implement or reimplement features, do NOT commit or push, do NOT review code quality or audit security — those belong to the other phases listed in the Pipeline section.

## Note contract
Record: checks executed and their result, problems found, what you fixed, and your verdict (approved / paused with reason).${CONTRACT}`,
  },
  {
    id: ID_SECURITY,
    i18nKey: ID_SECURITY,
    name: 'Security',
    description: 'Audit of dependencies, secrets and permissions',
    tools: ['read', 'shell'],
    isDefault: false,
    kind: 'security',
    prompt: `You audit the change for security problems. The task description is your primary brief — follow only the security-related parts of it.

1. Look for secrets committed by mistake (keys, tokens, credentials, .env files).
2. Check new or updated dependencies: known advisories, unnecessary or unmaintained packages.
3. Review permissions, authentication and input handling touched by this change.

You audit security ONLY. Do NOT implement features, do NOT validate, do NOT commit or push — those belong to the other phases listed in the Pipeline section. Report findings; only fix what is unambiguous and small.

## Note contract
Record: what was audited, findings by severity, what you fixed, what needs a human.${CONTRACT}`,
  },
  {
    id: ID_REVIEW,
    i18nKey: ID_REVIEW,
    name: 'Code review',
    description: 'Code review for quality and style',
    tools: ['read', 'edit', 'shell'],
    isDefault: false,
    kind: 'review',
    prompt: `You review the code of this task for quality — not for whether it runs (another phase covers that). The task description is your primary brief — follow only the parts that concern code quality.

Look for: duplication that should be reused, dead code, naming that does not match the codebase, missing error handling, comments that explain "what" instead of "why", and anything that would surprise the next maintainer.

You review quality ONLY. Do NOT implement features, do NOT validate, do NOT commit or push — those belong to the other phases listed in the Pipeline section. Apply the small cleanups yourself; report the rest.

## Note contract
Record: what you reviewed, what you changed, what you are flagging without changing.${CONTRACT}`,
  },
  {
    id: ID_INFRA,
    i18nKey: ID_INFRA,
    name: 'Infra',
    description: 'Deploy and environment checklist',
    tools: ['read', 'shell'],
    isDefault: false,
    kind: 'infra',
    prompt: `You check the infrastructure impact of this task. The task description is your primary brief — follow only the parts that concern deploy/environment.

Cover: environment variables and config that must change, migrations, build/deploy scripts affected, and anything that has to be done outside the repository for this change to work in production.

You check infrastructure ONLY. Do NOT implement features, do NOT validate, do NOT commit or push — those belong to the other phases listed in the Pipeline section.

## Note contract
Record: the deploy checklist for this task, what you verified, and what a human must do manually.${CONTRACT}`,
  },
]

/**
 * Default command policy (§8). Conservative on purpose: the pipeline runs with
 * nobody watching, so whatever is irreversible stays blocked and whatever
 * leaves the machine or changes dependencies is recorded.
 *
 * The comparison is by normalized command prefix — see command-policy.ts.
 */
export const DEFAULT_POLICY: CommandPolicy = {
  blocked: [
    'git push --force',
    'git push -f',
    'git reset --hard',
    'git clean -fdx',
    'git clean -fd',
    'rm -rf',
    'npm publish',
    'yarn publish',
    'pnpm publish',
    'npm uninstall',
    'yarn remove',
    'pnpm remove',
    'drop table',
    'drop database',
    'shutdown',
    'mkfs',
  ],
  controlled: [
    'git push',
    'git merge',
    'git rebase',
    'git checkout -b',
    'git switch -c',
    'npm install',
    'npm i ',
    'yarn add',
    'pnpm add',
    'pip install',
    'curl',
    'wget',
    'ssh',
    'scp',
    'docker',
  ],
}

export function defaultTemplates(): PhaseTemplate[] {
  return PHASE_TEMPLATES.filter((t) => t.isDefault)
}
