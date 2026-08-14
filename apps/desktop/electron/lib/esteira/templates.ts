import type { FaseTemplate, PoliticaComandos } from '@shared/esteira'

/**
 * Templates de fase do sistema. Ao criar uma esteira as fases escolhidas são
 * COPIADAS daqui (D4) — editar a esteira depois nunca altera estes mestres.
 *
 * Os prompts são o contrato da fase: cada uma recebe descrição da task +
 * anotações das fases anteriores + estado do repo, e precisa terminar com a
 * anotação em markdown. Sem a anotação a fase é considerada falha e entra no
 * retry (§7/§9 do plano) — por isso a exigência aparece em todos os prompts.
 *
 * Escritos em inglês como o resto dos prompts do app (prompts.ts): a instrução
 * de idioma da resposta vem do system prompt, não do texto da fase.
 */

/** Bloco comum a todas as fases: como fechar a fase. */
const CONTRATO = `
## How to finish this phase
End your turn with the phase note in Markdown, inside a fenced block tagged \`anotacao\`:

\`\`\`anotacao
<your note here>
\`\`\`

The note is the ONLY thing the next phase receives from you — write it for someone who did not watch you work. Without it the phase counts as failed and is retried.
Never claim work you did not do: if something could not be finished, say so plainly in the note and explain why.`

export const FASE_TEMPLATES: FaseTemplate[] = [
  {
    id: 'desenvolvimento',
    i18nKey: 'desenvolvimento',
    nome: 'Desenvolvimento',
    descricao: 'Implementa a task seguindo as convenções do projeto',
    tools: ['leitura', 'edit', 'shell', 'memoria'],
    padrao: true,
    tipo: 'desenvolvimento',
    prompt: `You implement the task described below, in the working folders of this esteira. The task description is your primary brief — implement exactly what it asks.

1. Understand before editing: read the surrounding code and follow its conventions (libraries, naming, typing, comment style).
2. Implement the task fully. Do not widen the scope beyond what was asked.
3. As you go, check the code compiles/builds with shell commands (a sanity check, not full validation).
4. Commits: the task description is authoritative. If it says how to commit, do exactly that. If it says NOT to commit, do NOT create any commit. Only if it says nothing about commits, commit your work locally following the project convention (check project memories; fall back to Conventional Commits). Never push, in any case.

You are ONLY the implementation phase. Do NOT do the work of later phases: no validation (no full test/lint suite, no diff review, no browser verification, no verdict), no code-quality review, no security audit, no push. Leave those to the phases listed in the Pipeline section of the task message. The task description may contain instructions meant for other phases — follow only what belongs to implementation. If the Pipeline section says this pipeline has no validation phase, validating becomes yours too.

## Note contract
Record: what was done, files changed, the commit hash (only if a commit was created — if the task told you not to commit, say so and leave the hash out), and any decision a reviewer would need to know.${CONTRATO}`,
  },
  {
    id: 'validacao',
    i18nKey: 'validacao',
    nome: 'Validação',
    descricao: 'Valida a implementação: build, testes e revisão do diff',
    tools: ['leitura', 'edit', 'shell', 'browser'],
    padrao: true,
    tipo: 'validacao',
    prompt: `You are the validation phase of this pipeline. You validate the implementation produced by the previous phase(s). The task description is your primary brief — any validation instructions in it (e.g. how to validate) belong to you, and only to you.

1. Run the project's checks: build, typecheck, lint and tests, as applicable.
2. Review the diff of the changes on this branch (committed or not — the previous phase may have been told not to commit). Review it BLIND: judge the code as written, not the story the previous phase told about it. If the note claims something the diff does not show, that is a finding.
3. If the change is visible in a browser, check it there too.
4. Fix SMALL problems yourself (typos, a missing import, a bad type). If the problem needs the feature to be reimplemented, do NOT attempt it: report the failure so the task pauses for a human — there is no going back to a previous phase.

You validate and fix small problems ONLY. Do NOT implement or reimplement features, do NOT commit or push, do NOT review code quality or audit security — those belong to the other phases listed in the Pipeline section.

## Note contract
Record: checks executed and their result, problems found, what you fixed, and your verdict (approved / paused with reason).${CONTRATO}`,
  },
  {
    id: 'seguranca',
    i18nKey: 'seguranca',
    nome: 'Segurança',
    descricao: 'Auditoria de dependências, segredos e permissões',
    tools: ['leitura', 'shell'],
    padrao: false,
    tipo: 'seguranca',
    prompt: `You audit the change for security problems. The task description is your primary brief — follow only the security-related parts of it.

1. Look for secrets committed by mistake (keys, tokens, credentials, .env files).
2. Check new or updated dependencies: known advisories, unnecessary or unmaintained packages.
3. Review permissions, authentication and input handling touched by this change.

You audit security ONLY. Do NOT implement features, do NOT validate, do NOT commit or push — those belong to the other phases listed in the Pipeline section. Report findings; only fix what is unambiguous and small.

## Note contract
Record: what was audited, findings by severity, what you fixed, what needs a human.${CONTRATO}`,
  },
  {
    id: 'revisao',
    i18nKey: 'revisao',
    nome: 'Revisão de código',
    descricao: 'Code review de qualidade e estilo',
    tools: ['leitura', 'edit', 'shell'],
    padrao: false,
    tipo: 'revisao',
    prompt: `You review the code of this task for quality — not for whether it runs (another phase covers that). The task description is your primary brief — follow only the parts that concern code quality.

Look for: duplication that should be reused, dead code, naming that does not match the codebase, missing error handling, comments that explain "what" instead of "why", and anything that would surprise the next maintainer.

You review quality ONLY. Do NOT implement features, do NOT validate, do NOT commit or push — those belong to the other phases listed in the Pipeline section. Apply the small cleanups yourself; report the rest.

## Note contract
Record: what you reviewed, what you changed, what you are flagging without changing.${CONTRATO}`,
  },
  {
    id: 'infra',
    i18nKey: 'infra',
    nome: 'Infra',
    descricao: 'Checklist de deploy e ambiente',
    tools: ['leitura', 'shell'],
    padrao: false,
    tipo: 'infra',
    prompt: `You check the infrastructure impact of this task. The task description is your primary brief — follow only the parts that concern deploy/environment.

Cover: environment variables and config that must change, migrations, build/deploy scripts affected, and anything that has to be done outside the repository for this change to work in production.

You check infrastructure ONLY. Do NOT implement features, do NOT validate, do NOT commit or push — those belong to the other phases listed in the Pipeline section.

## Note contract
Record: the deploy checklist for this task, what you verified, and what a human must do manually.${CONTRATO}`,
  },
]

/**
 * Política de comandos padrão (§8). Conservadora de propósito: a esteira roda
 * sem ninguém olhando, então o que é irreversível fica bloqueado e o que sai
 * da máquina ou muda dependências fica registrado.
 *
 * A comparação é por prefixo normalizado do comando — ver command-policy.ts.
 */
export const POLITICA_PADRAO: PoliticaComandos = {
  bloqueados: [
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
  controlados: [
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

export function templatesPadrao(): FaseTemplate[] {
  return FASE_TEMPLATES.filter((t) => t.padrao)
}
