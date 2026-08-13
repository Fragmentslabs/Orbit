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
    prompt: `You implement the task described below, in the working folders of this esteira.

1. Understand before editing: read the surrounding code and follow its conventions (libraries, naming, typing, comment style).
2. Implement the task fully. Do not widen the scope beyond what was asked.
3. Validate what you can as you go (build, typecheck, tests) with shell commands.
4. Commit your work following the user's commit convention (check project memories for it; fall back to Conventional Commits). Commit locally — do not push.

## Note contract
Record: what was done, files changed, the commit hash, and any decision a reviewer would need to know.${CONTRATO}`,
  },
  {
    id: 'validacao',
    i18nKey: 'validacao',
    nome: 'Validação',
    descricao: 'Valida a implementação: build, testes e revisão do diff',
    tools: ['leitura', 'edit', 'shell', 'browser'],
    padrao: true,
    prompt: `You validate the implementation produced by the previous phase.

1. Run the project's checks: build, typecheck, lint and tests, as applicable.
2. Review the diff of the commit(s) on this branch. Review it BLIND: judge the code as written, not the story the previous phase told about it. If the note claims something the diff does not show, that is a finding.
3. If the change is visible in a browser, check it there too.
4. Fix SMALL problems yourself (typos, a missing import, a bad type). If the problem needs the feature to be reimplemented, do NOT attempt it: report the failure so the task pauses for a human — there is no going back to a previous phase.

## Note contract
Record: checks executed and their result, problems found, what you fixed, and your verdict (approved / paused with reason).${CONTRATO}`,
  },
  {
    id: 'relatorio',
    nome: 'Relatório',
    descricao: 'Fecha a task e descreve o que foi feito',
    tools: ['leitura', 'shell'],
    padrao: true,
    // Obrigatória: é a fase que produz a descrição do que aconteceu. Sem ela
    // a task terminaria sem relato, e o board viraria uma caixa preta.
    fixa: true,
    i18nKey: 'relatorio',
    prompt: `You close the task.

1. Check the final state of the repository (branch/worktree of this esteira): status clean, commits present.
2. Write the task's final summary: what was delivered, which commits, what was validated, anything left open.
3. If this esteira is configured to push at the end, push the branch. Otherwise leave the commits local.

## Note contract
The note IS the task's final summary — it is what the user reads to know what happened.${CONTRATO}`,
  },
  {
    id: 'seguranca',
    i18nKey: 'seguranca',
    nome: 'Segurança',
    descricao: 'Auditoria de dependências, segredos e permissões',
    tools: ['leitura', 'shell'],
    padrao: false,
    prompt: `You audit the change for security problems.

1. Look for secrets committed by mistake (keys, tokens, credentials, .env files).
2. Check new or updated dependencies: known advisories, unnecessary or unmaintained packages.
3. Review permissions, authentication and input handling touched by this change.
Report findings; only fix what is unambiguous and small.

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
    prompt: `You review the code of this task for quality — not for whether it runs (another phase covers that).

Look for: duplication that should be reused, dead code, naming that does not match the codebase, missing error handling, comments that explain "what" instead of "why", and anything that would surprise the next maintainer. Apply the small cleanups yourself; report the rest.

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
    prompt: `You check the infrastructure impact of this task.

Cover: environment variables and config that must change, migrations, build/deploy scripts affected, and anything that has to be done outside the repository for this change to work in production.

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
