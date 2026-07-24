import { AlignLeft, Bot, Brain, BrainCircuit, FileText, Globe, KeyRound, Network, RefreshCw, Search, Shield } from "lucide-react"

interface ModeInfo {
  icon: typeof Shield
  label: string
  modes: string[]
  description: string
  detail: string
  combo?: string[]
}

const MODES: ModeInfo[] = [
  {
    icon: Search,
    label: "Pesquisa",
    modes: ["Chat", "Código"],
    description: "Busca e lê páginas da web via HTTP.",
    detail: "Adiciona as ferramentas websearch e webfetch ao agente. Rápido e eficiente para consultar documentação, APIs e informações públicas. Não executa JavaScript — ideal para conteúdo estático.",
    combo: ["Browser", "Thinking"],
  },
  {
    icon: Globe,
    label: "Browser",
    modes: ["Chat"],
    description: "Navega em páginas como um browser real.",
    detail: "Abre o painel direito com um navegador completo. Executa JavaScript, ideal para SPAs, formulários e páginas dinâmicas. O agente pode navegar, clicar, preencher campos e tirar screenshots.",
    combo: ["Pesquisa", "Thinking"],
  },
  {
    icon: Brain,
    label: "Thinking",
    modes: ["Chat", "Código"],
    description: "Raciocínio estendido do modelo.",
    detail: "Ativa o modo reasoning/thinking do modelo (quando suportado). O modelo \"pensa\" antes de responder, resultando em respostas mais profundas e bem fundamentadas. Consome mais tokens e tempo.",
    combo: ["Pesquisa", "Browser", "Loop"],
  },
  {
    icon: AlignLeft,
    label: "Simples",
    modes: ["Chat", "Código"],
    description: "Respostas diretas em texto puro.",
    detail: "Remove formatação avançada, citações e blocos de ferramentas da resposta. Útil quando você quer apenas o conteúdo essencial, sem enfeites.",
    combo: [],
  },
  {
    icon: BrainCircuit,
    label: "Memória (Brain)",
    modes: ["Chat", "Código"],
    description: "Orbit lembra fatos e preferências entre conversas.",
    detail: "Adiciona as ferramentas memory_save/search/link/open/graph. O Orbit pode salvar fatos, preferências e decisões e recuperá-los automaticamente em conversas futuras. Desative por chat se preferir uma interação sem contexto.",
    combo: [],
  },
  {
    icon: Bot,
    label: "Subagents",
    modes: ["Chat", "Código"],
    description: "Workers efêmeros em background para tarefas paralelas.",
    detail: "Adiciona a ferramenta subagent ao agente. Quando o agente identifica subtarefas independentes, ele pode delegá-las a workers efêmeros que rodam em background com o modelo configurado. Os workers são descartados ao fim da tarefa — não aparecem na sidebar.",
    combo: ["Loop", "Orchestra"],
  },
  {
    icon: Network,
    label: "Orchestra",
    modes: ["Código"],
    description: "Divide o pedido em plano de tarefas + workers persistentes.",
    detail: "O agente orquestrador planeja a tarefa (criando subtarefas com create_task), propõe o plano para sua aprovação e, após aprovado, executa cada subtarefa como uma sessão filha persistente no painel direito. Os workers rodam em paralelo com o modelo worker configurado. Resultado final é sintetizado pelo orquestrador.",
    combo: ["Loop", "Subagents"],
  },
  {
    icon: RefreshCw,
    label: "Loop",
    modes: ["Código"],
    description: "Agente revisa e itera até completar a tarefa.",
    detail: "Após cada resposta, o sistema revisa criticamente o resultado. Se o objetivo não foi totalmente atingido, o agente continua trabalhando automaticamente (nova iteração). O número máximo de iterações e o comportamento (automático ou com confirmação) são configuráveis no gear. Ideal para tarefas complexas que exigem refinamento.",
    combo: ["Subagents", "Orchestra", "Thinking"],
  },
  {
    icon: FileText,
    label: "Modo Plano",
    modes: ["Código"],
    description: "Apenas leitura — produz um plano sem editar arquivos.",
    detail: "Bloqueia ferramentas de escrita (write, edit, bash). O agente apenas lê o código e produz um plano de implementação detalhado. Útil para revisão e planejamento antes de executar alterações.",
    combo: ["Thinking", "Pesquisa"],
  },
  {
    icon: KeyRound,
    label: "Permissões",
    modes: ["Código"],
    description: "Controle de segurança sobre ações do agente.",
    detail: "Três níveis: Ask (pergunta antes de cada ação crítica), Approve (mostra resumo para aprovação), Full (executa automaticamente). Configurável no modal de Preferências ou diretamente no input.",
    combo: [],
  },
]

const COMBOS: { label: string; items: string[]; description: string }[] = [
  {
    label: "Pesquisa aprofundada",
    items: ["Pesquisa", "Browser", "Thinking"],
    description: "Ative Pesquisa + Browser + Thinking juntos. O agente searching, navega em páginas complexas e raciocina profundamente sobre o que encontrou. Ideal para investigar tópicos técnicos, comparar documentações ou fazer análise competitiva.",
  },
  {
    label: "Refinamento automático",
    items: ["Loop", "Thinking"],
    description: "Loop + Thinking: o agente revisa o próprio resultado com raciocínio estendido, identificando gaps e refinando até o objetivo ser atingido. Excelente para gerar código robusto, testes completos ou documentação detalhada.",
  },
  {
    label: "Orquestração com revisão",
    items: ["Orchestra", "Loop"],
    description: "Orchestra + Loop: o orquestrador divide o problema em tarefas, workers executam em paralelo, e após a síntese o loop revisa o resultado, criando workers de continuação se necessário. O melhor dos dois mundos para problemas complexos.",
  },
  {
    label: "Workers em múltiplas frentes",
    items: ["Orchestra", "Subagents"],
    description: "Orchestra + Subagents: o orquestrador coordena tarefas de alto nível (workers persistentes na sidebar), e dentro de cada tarefa o worker pode usar subagents efêmeros para investigações pontuais. Máximo de paralelismo.",
  },
  {
    label: "Planejamento cuidadoso",
    items: ["Modo Plano", "Thinking", "Pesquisa"],
    description: "Modo Plano + Thinking + Pesquisa: antes de qualquer alteração, o agente pesquisa documentação, raciocina profundamente e produz um plano detalhado de implementação sem modificar arquivos. Aprove o plano e depois execute com as ferramentas normais.",
  },
  {
    label: "Código com segurança",
    items: ["Permissão: Ask", "Loop"],
    description: "Permissão Ask + Loop: a cada iteração do loop, o agente pode pedir permissão antes de ações sensíveis (editar arquivos, executar comandos). Seguro para revisar código de terceiros ou fazer alterações em produção.",
  },
]

export function HowToPanel() {
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">Modos e Ferramentas</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          O Orbit oferece vários modos que modificam o comportamento do agente.
          Ative-os antes de enviar a mensagem e combine-os para tarefas mais complexas.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {MODES.map((mode) => (
          <div key={mode.label} className="flex flex-col gap-1.5 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <mode.icon className="size-4 shrink-0 text-primary" />
              <span className="text-sm font-medium">{mode.label}</span>
              <div className="flex gap-1">
                {mode.modes.map((m) => (
                  <span key={m} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {m}
                  </span>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{mode.description}</p>
            <p className="text-xs leading-relaxed">{mode.detail}</p>
            {mode.combo && mode.combo.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                Combina bem com: {mode.combo.join(", ")}
              </p>
            )}
          </div>
        ))}
      </div>

      <div>
        <p className="text-sm font-semibold">Combinações Recomendadas</p>
        <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
          Alguns modos funcionam melhor juntos. Aqui estão combinações testadas:
        </p>
        <div className="flex flex-col gap-3">
          {COMBOS.map((combo) => (
            <div key={combo.label} className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {combo.items.map((item) => {
                  const mode = MODES.find((m) => m.label === item)
                  const Icon = mode?.icon ?? Shield
                  return (
                    <span key={item} className="flex items-center gap-1 rounded-md bg-background px-1.5 py-0.5 text-[10px] font-medium">
                      <Icon className="size-3" />
                      {item}
                    </span>
                  )
                })}
              </div>
              <p className="text-xs leading-relaxed">{combo.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
        <p className="text-xs font-medium text-primary">Dica</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Todos os modos e suas configurações ficam disponíveis no input de mensagem.
          Use os toggles abaixo do input para ativar/desativar rapidamente,
          ou clique no botão "+" para acessar Subagents, Orchestra e Loop com suas configurações avançadas.
        </p>
      </div>
    </div>
  )
}
