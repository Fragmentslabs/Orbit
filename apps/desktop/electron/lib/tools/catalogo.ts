import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'

/**
 * Catálogo de tools sob demanda — o funil de quatro camadas do plano
 * (núcleo → família → servidor MCP → busca).
 *
 * Regras que este módulo garante:
 * - **Nada é truncado em silêncio.** Uma família indisponível aparece no mapa
 *   COM o motivo ("só no modo código", "modo plano é leitura"), porque o
 *   modelo não deve descobrir a indisponibilidade chamando a tool.
 * - **Determinismo.** Ordem fixa de famílias e nomes: o bloco é byte-estável,
 *   e é o que preserva o prefixo de cache do prompt.
 * - **Derivado, nunca mutado.** O catálogo é reconstruído a cada montagem a
 *   partir do ToolSet real; nada de estado de sessão que possa derivar.
 */

/** Família = conjunto de tools que o modelo carrega de uma vez. */
export interface FamiliaFerramenta {
  id: string
  /** Rótulo curto para o mapa. */
  label: string
  /** UMA linha: o que a família resolve. É o que decide a escolha do modelo. */
  descricao: string
  /** Instruções que viajam no resultado do `tools_load` (o manual da família). */
  manual?: string
  /** Nomes que existem NESTE turno. Vazio = indisponível agora. */
  tools: string[]
  /** Por que está indisponível quando `tools` está vazio. */
  indisponivel?: string
  /** Família de servidor MCP (o id é o nome do servidor). */
  mcp?: boolean
}

/**
 * Estimativa de tokens deliberadamente conservadora: 4 chars por token
 * SUBESTIMA o custo real, e subestimar erra para o lado de ativar menos
 * famílias — o erro barato. Mesma escolha do Hermes (`CHARS_PER_TOKEN = 4.0`).
 */
export const CHARS_POR_TOKEN = 4

export function estimarTokens(texto: string): number {
  return Math.ceil(texto.length / CHARS_POR_TOKEN)
}

/** Tokens de uma definição de tool, medidos pelo JSON do schema. */
export function tokensDoSchema(tool: unknown): number {
  try {
    return estimarTokens(JSON.stringify(tool))
  } catch {
    return 0
  }
}

/**
 * Núcleo: sempre ativo, em ordem fixa (é o prefixo de cache).
 *
 * `question` e `todowrite` ficam aqui por EVIDÊNCIA, não por gosto: o A/B do
 * Hermes mostra que diferir a tool de esclarecimento derruba o uso de 18/18
 * para 7/18 — o modelo simplesmente para de perguntar e chuta. `todowrite`
 * pelo mesmo motivo: é barato e usado em quase todo turno.
 */
export const NUCLEO: readonly string[] = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'ls',
  'code_search',
  'code_outline',
  'code_refs',
  'todowrite',
  'question',
  'verify_changes',
  'session_context',
  'doc_list',
  'doc_search',
  'doc_read',
  'pdf_view_page',
  'sheet_query',
  'show_image',
  // As duas pontes do mecanismo: sem elas o funil não tem porta.
  'tools_load',
  'tools_list',
]

export const NUCLEO_SET: ReadonlySet<string> = new Set(NUCLEO)

/** Famílias declaradas. A ordem aqui é a ordem do mapa (determinística). */
interface FamiliaDecl {
  id: string
  label: string
  descricao: string
  manual?: string
  /** Prefixos de nome que pertencem à família. */
  prefixos: string[]
  /** Nomes exatos que não seguem prefixo. */
  exatos?: string[]
  /** Regra de indisponibilidade, quando a família não tem tool nenhuma. */
  indisponivel?: (input: SendMessageInput) => string | undefined
}

const FAMILIAS: readonly FamiliaDecl[] = [
  {
    id: 'files',
    label: 'files',
    descricao: 'Ler, escrever, editar e rodar comandos na pasta de trabalho.',
    prefixos: ['bash_', 'background_'],
    exatos: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'ls'],
    indisponivel: (i) => (i.mode === 'chat' ? 'só no modo código' : i.options.plan ? 'modo plano é só leitura' : undefined),
  },
  {
    id: 'code-index',
    label: 'code-index',
    descricao: 'Índice de símbolos: onde algo é definido, a assinatura, quem chama.',
    prefixos: ['code_'],
    indisponivel: (i) => (i.mode === 'chat' ? 'só no modo código' : undefined),
  },
  {
    id: 'documents',
    label: 'documents',
    descricao: 'PDF, DOCX, planilha e documentos próprios: ler, consultar, extrair, criar.',
    prefixos: ['doc_', 'docx_', 'pdf_', 'document_'],
    exatos: ['sheet_query', 'create_document', 'update_document', 'read_document', 'list_documents'],
  },
  {
    id: 'image',
    label: 'image',
    descricao: 'Editar imagem por pixel: cortar, comprimir, cor, fundo, texto.',
    prefixos: ['image_', 'describe_image'],
    exatos: ['show_image'],
  },
  {
    id: 'svg',
    label: 'svg',
    descricao: 'Vetor: criar, recolorir, rasterizar e vetorizar.',
    prefixos: ['svg_'],
  },
  {
    id: 'video',
    label: 'video',
    descricao: 'Edição de vídeo por EDL: sondar, transcrever, timeline, render, cortar.',
    prefixos: ['video_'],
    exatos: ['transcribe'],
    indisponivel: (i) => (i.mode === 'chat' ? undefined : undefined),
  },
  {
    id: 'media',
    label: 'media',
    descricao: 'Comprimir/convertir vídeo e áudio para um teto em bytes.',
    prefixos: ['media_'],
  },
  {
    id: 'ytdlp',
    label: 'ytdlp',
    descricao: 'Mídia por link: baixar vídeo/áudio e ler a transcrição.',
    prefixos: ['ytdlp_'],
  },
  {
    id: 'motion',
    label: 'motion',
    descricao: 'Peça animada (intro, kinetic text, lower third) na aba Motion.',
    prefixos: ['motion_'],
  },
  {
    id: 'design',
    label: 'design',
    descricao: 'Canvas de design: telas, mockups, logos, variantes.',
    prefixos: ['design_'],
  },
  {
    id: 'slides',
    label: 'slides',
    descricao: 'Apresentação em slides, com notas do apresentador.',
    prefixos: ['slides_'],
  },
  {
    id: 'pieces',
    label: 'pieces',
    descricao: 'Exportar uma peça do Orbit para pastas do projeto.',
    prefixos: ['piece_'],
  },
  {
    id: 'fonts',
    label: 'fonts',
    descricao: 'Catálogo de fontes: buscar e instalar na biblioteca do app.',
    prefixos: ['font_'],
  },
  {
    id: 'browser',
    label: 'browser',
    descricao: 'Browser do painel: abrir página, extrair links.',
    prefixos: ['browser_'],
    indisponivel: (i) => (i.mode === 'chat' && !i.options.browser ? 'o toggle Browser está desligado nesta conversa' : undefined),
  },
  {
    id: 'browser-test',
    label: 'browser-test',
    descricao: 'Testar app web: clicar, ler a página, console, screenshots, gravar demo.',
    prefixos: ['panel_', 'run_browser_', 'capture_'],
    exatos: ['browser_record'],
    indisponivel: (i) => (i.mode === 'chat' ? 'só no modo código' : 'as ferramentas de navegador estão desligadas nas Preferências'),
  },
  {
    id: 'research',
    label: 'research',
    descricao: 'Buscar e ler na web, e procurar imagens.',
    prefixos: ['web', 'image_search'],
    indisponivel: (i) => (i.options.research ? undefined : 'o toggle Pesquisa está desligado nesta conversa'),
  },
  {
    id: 'artifacts',
    label: 'artifacts',
    descricao: 'Página HTML interativa dentro da resposta (dashboard, protótipo, simulador).',
    prefixos: ['create_artifact', 'update_artifact', 'edit_artifact', 'read_artifact'],
  },
  {
    id: 'panel',
    label: 'panel',
    descricao: 'Ler o que está aberto na aba lateral.',
    prefixos: ['read_open_panel'],
  },
  {
    id: 'skills',
    label: 'skills',
    descricao: 'Ler uma skill sob demanda e propor uma nova.',
    prefixos: ['skill_', 'create_skill'],
  },
  {
    id: 'memory',
    label: 'memory',
    descricao: 'Memória do projeto: árvore, busca, salvar e ligar nós.',
    prefixos: ['memory_'],
    exatos: ['set_user_name'],
    indisponivel: (i) => (i.options.brain ? undefined : 'o Brain está desligado nesta conversa'),
  },
  {
    id: 'subagent',
    label: 'subagent',
    descricao: 'Delegar uma subtarefa a um worker isolado.',
    prefixos: ['subagent'],
    indisponivel: (i) => (i.options.subagents ? undefined : 'a delegação está desligada nesta conversa'),
  },
  {
    id: 'subchats',
    label: 'subchats',
    descricao: 'Abrir/ler conversas anexadas a esta e mandar instrução para elas.',
    prefixos: ['suggest_subchat', 'open_subchat', 'send_to_subchat', 'read_subchat'],
  },
  {
    id: 'sessions',
    label: 'sessions',
    descricao: 'Manutenção dos chats: listar por inatividade, arquivar, excluir.',
    prefixos: ['chat_'],
  },
  {
    id: 'esteira',
    label: 'esteira',
    descricao: 'Virar trabalho em task de um board e ler o estado.',
    prefixos: ['esteira_'],
  },
  {
    id: 'rotinas',
    label: 'rotinas',
    descricao: 'Agendar: criar, listar, rodar, pausar e remover rotinas.',
    prefixos: ['rotinas_'],
    indisponivel: (i) => (i.options.plan ? 'modo plano não cria rotinas' : undefined),
  },
  {
    id: 'worktrees',
    label: 'worktrees',
    descricao: 'Cópias isoladas do repositório em outra branch.',
    prefixos: ['worktree_'],
  },
  {
    id: 'usage',
    label: 'usage',
    descricao: 'Relatório de horas e custo por dia/projeto.',
    prefixos: ['usage_', 'work_report'],
  },
  {
    id: 'computer',
    label: 'computer',
    descricao: 'Controlar o computador: ver a tela, clicar, digitar.',
    prefixos: ['computer_'],
    indisponivel: () => 'o Computer use está desligado nas Preferências',
  },
  {
    id: 'audio',
    label: 'audio',
    descricao: 'Gerar fala a partir de texto.',
    prefixos: ['audio_'],
    indisponivel: () => 'o "Texto em fala" está desligado nas Preferências',
  },
  {
    id: 'overlay',
    label: 'overlay',
    descricao: 'Painel do atalho global: ver a tela e encerrar a conversa falada.',
    prefixos: ['overlay_', 'end_call'],
    indisponivel: () => 'só na janela do atalho (⇧⌘espaço)',
  },
  {
    id: 'mcp-connect',
    label: 'mcp-connect',
    descricao: 'Propor conexão MCP nova, corrigir uma existente, ler o estado.',
    prefixos: ['mcp_'],
  },
  {
    id: 'todo',
    label: 'todo',
    descricao: 'Lista viva de tarefas do turno.',
    prefixos: ['todowrite'],
  },
  {
    id: 'question',
    label: 'question',
    descricao: 'Perguntar ao usuário com opções.',
    prefixos: ['question'],
  },
]

/** Família de um nome de tool — ou null quando é de servidor MCP. */
function familiaDecl(nome: string): FamiliaDecl | null {
  for (const fam of FAMILIAS) {
    if (fam.exatos?.includes(nome)) return fam
    if (fam.prefixos.some((p) => nome.startsWith(p))) return fam
  }
  return null
}

/**
 * Servidor MCP pelo nome da tool (`<servidor>_<tool>`). O prefixo só conta
 * como servidor se o nome estiver no ToolSet montado — o que elimina o falso
 * positivo que já assombrou `permission/rules.ts`.
 */
function servidorMcp(nome: string, servidores: ReadonlySet<string>): string | null {
  for (const servidor of servidores) {
    if (nome.startsWith(`${servidor}_`)) return servidor
  }
  return null
}

/**
 * Agrupa o ToolSet REAL em famílias.
 *
 * A classificação é feita depois da montagem (e não com `add()` em cada
 * `Object.assign`) porque `buildToolSet` tem ~40 ramos condicionais: reescrevê-lo
 * para ganhar os mesmos nomes seria blast radius sem ganho. O teste
 * `catalogo.test.ts` garante que toda tool conhecida cai numa família — é o
 * que impede a deriva que a tabela estática normalmente sofre.
 */
export function classificarFamilias(
  tools: ToolSet,
  input: SendMessageInput,
  /** Servidores MCP cujo prefixo vale como família (`<servidor>_`). */
  servidoresMcp: readonly string[] = [],
  /** Servidores ligados que não subiram: família vazia, com o motivo. */
  unavailableMcp: readonly { prefix: string; reason: string }[] = [],
): FamiliaFerramenta[] {
  const nomes = Object.keys(tools)
  const servidores = new Set(servidoresMcp)
  const porFamilia = new Map<string, string[]>()
  const mcpPorServidor = new Map<string, string[]>()
  const soltas: string[] = []

  for (const nome of nomes) {
    if (NUCLEO_SET.has(nome)) continue
    const servidor = servidorMcp(nome, servidores)
    if (servidor) {
      mcpPorServidor.set(servidor, [...(mcpPorServidor.get(servidor) ?? []), nome])
      continue
    }
    const fam = familiaDecl(nome)
    if (!fam) {
      soltas.push(nome)
      continue
    }
    porFamilia.set(fam.id, [...(porFamilia.get(fam.id) ?? []), nome])
  }

  const familias: FamiliaFerramenta[] = []
  // Famílias declaradas, na ordem da tabela (determinismo). Presentes mesmo
  // quando não têm tool agora — com o motivo, para o mapa não esconder nada.
  for (const fam of FAMILIAS) {
    const presentes = (porFamilia.get(fam.id) ?? []).sort()
    if (presentes.length > 0) {
      familias.push({
        id: fam.id,
        label: fam.label,
        descricao: fam.descricao,
        manual: fam.manual,
        tools: presentes,
      })
    } else {
      const motivo = fam.indisponivel?.(input)
      // Sem motivo declarado, a família simplesmente não existe neste turno
      // (ex.: `fonts` no chat nunca é montada) — não vai ao mapa como
      // "desativada" para não sugerir uma capacidade que o modo não tem.
      if (motivo) {
        familias.push({ id: fam.id, label: fam.label, descricao: fam.descricao, tools: [], indisponivel: motivo })
      }
    }
  }
  // Servidores MCP: derivados, ordenados por nome. Os que falharam entram na
  // MESMA lista, vazios e com o motivo — some do mapa seria dizer que a
  // capacidade não existe, quando o que houve foi um servidor fora do ar.
  const mcpFalhos = new Map(unavailableMcp.map((s) => [s.prefix, s.reason]))
  for (const servidor of [...new Set([...mcpPorServidor.keys(), ...mcpFalhos.keys()])].sort()) {
    const presentes = (mcpPorServidor.get(servidor) ?? []).sort()
    familias.push({
      id: `mcp:${servidor}`,
      label: `@mcp:${servidor}`,
      descricao: `Servidor MCP ${servidor}.`,
      tools: presentes,
      ...(presentes.length === 0
        ? { indisponivel: `failed to connect: ${mcpFalhos.get(servidor)}` }
        : {}),
      mcp: true,
    })
  }
  // O que não casou com família nenhuma continua carregável por nome — nunca
  // inalcançável. `ORBIT_DEBUG_TOOLSET=1` lista esses nomes para a tabela
  // acima ser corrigida.
  if (soltas.length > 0) {
    familias.push({
      id: 'outras',
      label: 'outras',
      descricao: 'Tools sem família declarada (carregue por nome com tools_load).',
      tools: soltas.sort(),
    })
  }
  return familias
}

/** Todas as famílias declaram o que são para o mapa. */
export function descricaoDaFamilia(id: string): string {
  return FAMILIAS.find((f) => f.id === id)?.descricao ?? FAMILIAS.find((f) => `mcp:${f.id}` === id)?.descricao ?? ''
}

/**
 * Orçamento do mapa: `min(teto, fração do contexto)`. Fração pequena de
 * propósito — o mapa é índice, não manual.
 */
/**
 * Freio de mão (Fase 0): provedores com teto de tools (Groq: 128) derrubam o
 * request INTEIRO quando o ToolSet passa. Corta primeiro os servidores MCP —
 * a única fonte imprevisível de tools — do maior para o menor; se ainda não
 * couber, corta o que não é núcleo. O que cai fica no mapa marcado como
 * indisponível, com o motivo, em vez de sumir em silêncio.
 *
 * Devolve os rótulos do que foi cortado (vazio = nada aconteceu).
 */
export function aplicarFreio(
  tools: ToolSet,
  familias: FamiliaFerramenta[],
  limite: number | undefined,
): string[] {
  if (!limite) return []
  let total = Object.keys(tools).length
  if (total <= limite) return []

  const cortadas: string[] = []
  const mcp = familias.filter((f) => f.mcp).sort((a, b) => b.tools.length - a.tools.length)
  for (const familia of mcp) {
    if (total <= limite) break
    for (const nome of familia.tools) delete tools[nome]
    total -= familia.tools.length
    cortadas.push(familia.label)
  }

  if (total > limite) {
    for (const nome of Object.keys(tools)) {
      if (total <= limite) break
      if (NUCLEO_SET.has(nome)) continue
      delete tools[nome]
      total -= 1
    }
    cortadas.push('famílias não essenciais')
  }

  // Reconcilia o catálogo com o que sobrou: família vazia vira "desativada".
  const motivo = `cortada pelo teto de ${limite} tools do provedor`
  for (const familia of familias) {
    const restantes = familia.tools.filter((nome) => nome in tools)
    if (restantes.length === familia.tools.length) continue
    familia.tools = restantes
    if (restantes.length === 0 && !familia.indisponivel) familia.indisponivel = motivo
  }
  return cortadas
}

export function orcamentoDoMapa(contextLength: number, tetoTokens = 700): number {
  return Math.max(120, Math.min(tetoTokens, Math.floor(contextLength * 0.04)))
}

/**
 * Mapa do prompt, com degradação por família quando estoura o orçamento.
 *
 * Formas (referência: Hermes, `tools_search_catalog.py`): `full` (nome + linha)
 * → `names` (só nomes) → `groups` (contagem, "use a busca"). A degradação é por
 * família, do maior para o menor, para um servidor gigante não custar a
 * listagem de um pequeno.
 */
export function montarMapa(
  familias: readonly FamiliaFerramenta[],
  opcoes: { orcamento?: number; ativas?: ReadonlySet<string> } = {},
): { texto: string; tokens: number } {
  const orcamento = opcoes.orcamento ?? 700
  const ativas = opcoes.ativas ?? new Set<string>()
  const linhas: string[] = []
  let restante = orcamento

  const custo = (linha: string) => estimarTokens(linha)
  const marcador = (fam: FamiliaFerramenta) => {
    if (fam.indisponivel) return ` (desativado: ${fam.indisponivel})`
    if (ativas.has(fam.id)) return ' (ATIVO)'
    return ''
  }
  // Família nativa tem nomes previsíveis (o modelo sabe que `documents` tem
  // doc_read); servidor MCP é vocabulário desconhecido — ali os nomes são o que
  // decide. Nomes demais não cabem: degrada para a contagem.
  const MAX_NOMES_NO_MAPA = 12
  const linhaCheia = (fam: FamiliaFerramenta) => {
    const nomes = fam.mcp
      ? fam.tools.slice(0, MAX_NOMES_NO_MAPA).join(', ') +
        (fam.tools.length > MAX_NOMES_NO_MAPA ? ', …' : '')
      : fam.descricao
    return `- ${fam.label} — ${fam.tools.length} tools: ${nomes}${marcador(fam)}`
  }

  // Ordem de degradação: as maiores primeiro perdem detalhe.
  const ordenadas = [...familias].sort((a, b) => b.tools.length - a.tools.length)
  const forma = new Map<string, 'full' | 'names' | 'groups'>()
  for (const fam of ordenadas) {
    const cheia = linhaCheia(fam)
    const soNomes = `- ${fam.label} — ${fam.tools.join(', ')}${marcador(fam)}`
    const grupo = `- ${fam.label} — ${fam.tools.length} tools (nomes não listados; use tools_load)${marcador(fam)}`
    if (fam.indisponivel || fam.tools.length === 0) {
      forma.set(fam.id, 'full')
      continue
    }
    if (custo(cheia) <= restante) forma.set(fam.id, 'full')
    else if (custo(soNomes) <= restante) forma.set(fam.id, 'names')
    else forma.set(fam.id, 'groups')
    restante -= custo(
      forma.get(fam.id) === 'full' ? cheia : forma.get(fam.id) === 'names' ? soNomes : grupo,
    )
  }

  // Emissão na ordem declarada (byte-estável), com a forma decidida acima.
  for (const fam of familias) {
    const f = forma.get(fam.id) ?? 'full'
    if (fam.indisponivel || fam.tools.length === 0) {
      linhas.push(`- ${fam.label} — 0 tools${marcador(fam)}`)
    } else if (f === 'full') {
      linhas.push(linhaCheia(fam))
    } else if (f === 'names') {
      linhas.push(`- ${fam.label} — ${fam.tools.join(', ')}${marcador(fam)}`)
    } else {
      linhas.push(`- ${fam.label} — ${fam.tools.length} tools (nomes não listados; use tools_load)${marcador(fam)}`)
    }
  }
  const texto = linhas.join('\n')
  return { texto, tokens: estimarTokens(texto) }
}
