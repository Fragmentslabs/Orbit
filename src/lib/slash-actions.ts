import type { SendMessageOptions, SessionMode } from "@/shared/chat"

/**
 * Ações "/" do palette: pipelines pré-definidos, não templates soltos.
 * Selecionar no palette insere "/comando " no input; no submit o texto é
 * resolvido em prompt estruturado + options (o Enter é a confirmação do
 * usuário). Pipelines destrutivos (refactor, debug) ainda param no meio via
 * tool `question` antes de aplicar mudanças.
 */

export type SlashActionKind = "pipeline" | "insert" | "init"

export interface SlashActionSpec {
  /** id sem barra ("code-review") */
  id: string
  /** comando digitado ("/code-review") */
  command: string
  description: string
  keywords: string[]
  /** Modos onde a ação aparece no palette */
  modes: SessionMode[]
  kind: SlashActionKind
  /** kind insert: texto que substitui o input */
  insertText?: string
  /** kind pipeline: monta o prompt com o resto do texto digitado */
  buildPrompt?: (input: string) => string
  /** Options mescladas às do input ao enviar */
  options?: Partial<SendMessageOptions>
}

const target = (input: string, fallback: string) => (input.trim() ? input.trim() : fallback)

export const SLASH_ACTIONS: SlashActionSpec[] = [
  {
    id: "code-review",
    command: "/code-review",
    description: "Revisa o diff atual (ou um alvo): pontos críticos → sugestões → aplica as aprovadas",
    keywords: ["review", "revisao", "pr", "diff"],
    modes: ["code"],
    kind: "pipeline",
    buildPrompt: (input) => `Faça um code review completo seguindo este pipeline:

1. **Levantar o alvo**: ${target(input, "rode `git diff` (e `git diff --staged`) na pasta do projeto; se não houver mudanças, use `git show HEAD`")}
2. **Analisar pontos críticos**: bugs, edge cases, segurança, performance, legibilidade e aderência às convenções do projeto (consulte a memória do projeto se disponível).
3. **Relatar**: liste os achados por severidade (crítico / importante / sugestão), cada um com arquivo:linha e explicação curta.
4. **Confirmar**: use a ferramenta question para perguntar QUAIS correções devo aplicar.
5. **Aplicar** apenas as aprovadas e mostrar um resumo do que mudou.`,
  },
  {
    id: "refactor",
    command: "/refactor",
    description: "Analisa estrutura → propõe melhoria → executa com validação (tests + typecheck)",
    keywords: ["refatorar", "refactor", "melhorar codigo"],
    modes: ["code"],
    kind: "pipeline",
    buildPrompt: (input) => `Refatore com validação, seguindo este pipeline:

1. **Alvo**: ${target(input, "identifique pela conversa/contexto o arquivo ou módulo a refatorar; se ambíguo, pergunte")}
2. **Analisar** a estrutura atual: responsabilidades, duplicação, acoplamento, nomes.
3. **Propor** a refatoração (o que muda, por quê, riscos) e AGUARDAR minha confirmação via ferramenta question antes de tocar em qualquer arquivo.
4. **Executar** a refatoração aprovada em passos pequenos.
5. **Validar**: rode typecheck e os testes do projeto (descubra os comandos em package.json/scripts ou equivalente). Se algo quebrar, corrija antes de concluir.
6. **Resumir** o que mudou e o resultado da validação.`,
  },
  {
    id: "melhorar-ui",
    command: "/melhorar-ui",
    description: "Analisa acessibilidade, responsividade e consistência com o design system",
    keywords: ["ui", "interface", "design", "acessibilidade", "a11y"],
    modes: ["code"],
    kind: "pipeline",
    buildPrompt: (input) => `Melhore a interface seguindo este pipeline:

1. **Alvo**: ${target(input, "identifique pela conversa o componente/tela; se ambíguo, pergunte")}
2. **Analisar** em três eixos:
   - Acessibilidade: semântica, foco, contraste, aria, navegação por teclado
   - Responsividade: comportamento em larguras pequenas, overflow, truncamento
   - Consistência: compare com o design system / componentes ui existentes do projeto (consulte a memória de design do projeto se disponível)
3. **Sugerir** as mudanças em lista priorizada, com trecho de código para cada uma.
4. **Perguntar** via ferramenta question quais aplicar, e aplicar as aprovadas.`,
  },
  {
    id: "ler-pdf",
    command: "/ler-pdf",
    description: "Extrai o conteúdo do PDF anexado → resume ou responde perguntas",
    keywords: ["pdf", "documento", "extrair"],
    modes: ["chat", "code"],
    kind: "pipeline",
    buildPrompt: (input) => `Leia o PDF anexado a esta mensagem.
${input.trim() ? `Tarefa: ${input.trim()}` : "Tarefa: produza um resumo estruturado — tema, pontos-chave por seção, conclusões e quaisquer dados/tabelas relevantes."}
Se nenhum PDF estiver anexado, me avise em vez de inventar conteúdo.`,
  },
  {
    id: "ler-docx",
    command: "/ler-docx",
    description: "Converte o DOCX anexado para texto → resume ou responde perguntas",
    keywords: ["docx", "word", "documento"],
    modes: ["chat", "code"],
    kind: "pipeline",
    buildPrompt: (input) => `Leia o arquivo DOCX anexado a esta mensagem. Se não conseguir ler o formato diretamente, use as ferramentas disponíveis para extrair o texto (em modo código, um script rápido resolve — .docx é um zip com word/document.xml).
${input.trim() ? `Tarefa: ${input.trim()}` : "Tarefa: produza um resumo estruturado do documento."}
Se nenhum DOCX estiver anexado, me avise.`,
  },
  {
    id: "analisar-imagem",
    command: "/analisar-imagem",
    description: "Descreve ou extrai informações da imagem anexada",
    keywords: ["imagem", "screenshot", "foto", "ocr"],
    modes: ["chat", "code"],
    kind: "pipeline",
    buildPrompt: (input) => `Analise a imagem anexada a esta mensagem.
${input.trim() ? `Tarefa: ${input.trim()}` : "Tarefa: descreva o conteúdo em detalhe e transcreva qualquer texto visível."}
Se nenhuma imagem estiver anexada, me avise.`,
  },
  {
    id: "explicar",
    command: "/explicar",
    description: "Explica um trecho de código com o contexto do projeto",
    keywords: ["explicar", "explain", "entender", "codigo"],
    modes: ["chat", "code"],
    kind: "pipeline",
    buildPrompt: (input) => `Explique o seguinte com contexto:

${target(input, "(cole o trecho de código ou indique arquivo:linhas)")}

Estruture a explicação em: o que faz (visão geral) → como funciona (passo a passo) → por que existe (papel no projeto, se identificável pelo contexto/memória) → pontos de atenção.`,
  },
  {
    id: "debug",
    command: "/debug",
    description: "Analisa log de erro / stack trace → causa raiz → sugere ou aplica correção",
    keywords: ["debug", "erro", "stack", "trace", "bug"],
    modes: ["code"],
    kind: "pipeline",
    buildPrompt: (input) => `Depure este problema seguindo o pipeline:

${target(input, "(cole o log de erro ou stack trace)")}

1. **Interpretar** o erro: o que ele diz literalmente e onde acontece.
2. **Investigar** a causa raiz no código (leia os arquivos envolvidos — não pare no sintoma).
3. **Explicar** a causa raiz em 2-3 frases.
4. **Corrigir**: proponha a correção e, antes de aplicar qualquer mudança, confirme comigo via ferramenta question. Depois de aplicar, valide (typecheck/teste relevante).`,
  },
  {
    id: "buscar-memoria",
    command: "/buscar-memoria",
    description: "Busca textual nas memórias (Brain) antes de responder",
    keywords: ["lembrar", "memoria", "brain", "recall", "buscar"],
    modes: ["chat", "code"],
    kind: "pipeline",
    buildPrompt: (input) => `Busque nas memórias do projeto (Brain) o que for relevante para: ${target(input, "liste todas as memórias disponíveis e seus resumos")}

Use as memórias encontradas para responder com detalhes, citando as fontes. Se a busca não encontrar nada relevante, informe o usuário e sugira criar uma memória sobre o assunto.`,
  },
  {
    id: "init",
    command: "/init",
    description: "Analisa o projeto e gera/complementa memórias por área (stack, arquitetura, design…)",
    keywords: ["init", "analisar projeto", "scan", "onboarding"],
    modes: ["code"],
    kind: "init",
  },
  {
    id: "init-force",
    command: "/init-force",
    description: "Reanalisa o projeto do zero e sobrescreve as memórias existentes",
    keywords: ["init-force", "force", "reanalisar", "sobrescrever"],
    modes: ["code"],
    kind: "init",
  },
]

export function actionsForMode(mode: SessionMode): SlashActionSpec[] {
  return SLASH_ACTIONS.filter((a) => a.modes.includes(mode))
}

/** Comandos completos — usados também pelo palette para fechar sobre eles */
export const SLASH_ACTION_COMMANDS = SLASH_ACTIONS.map((a) => a.command)

export interface ResolvedSlashAction {
  action: SlashActionSpec
  /** Resto do texto após o comando */
  input: string
  /** kind pipeline: prompt final a enviar */
  prompt?: string
}

/**
 * Resolve um texto de input que começa com um comando "/" conhecido.
 * Comandos mais longos têm precedência ("/ler-pdf" antes de um "/ler" futuro).
 */
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
