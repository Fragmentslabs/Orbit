# Plano: Comandos "/", /init e Graph de Memórias

## 1. Comandos "/" — Ações Padrão

### Problema
Hoje o usuário precisa digitar manualmente prompts inteiros pra operações recorrentes como "faz code review desse PR", "refatora esse arquivo" ou "melhora a interface desse componente". O palette de comandos `/` já existe mas tem ordenação errada e poucas ações úteis.

### Solução
Adicionar **comandos `/`** que executam pipelines pré-definidos com orquestração (não templates de texto — fluxos reais com agentes, ferramentas e validação).

### Ações propostas

| Comando | Pipeline |
|---------|----------|
| **/code-review** | Lê diff / arquivo → analisa pontos críticos → sugere mudanças → aplica as aprovadas |
| **/refactor** | Analisa estrutura → propõe melhoria → executa com validação (tests + typecheck) |
| **/melhorar-ui** | Analisa acessibilidade, responsividade, consistência com design system → sugere mudanças |
| **/ler-pdf** | Extrai texto do PDF anexado → resume ou responde perguntas |
| **/ler-docx** | Converte DOCX pra texto → mesmo fluxo do PDF |
| **/analisar-imagem** | Descreve ou extrai informações da imagem anexada |
| **/explicar** | Selecionar trecho de código → gera explicação com contexto do projeto |
| **/debug** | Cola log de erro / stack trace → analisa causa raiz → sugere ou aplica correção |
| **/buscar-memoria** | Busca textual em memórias (atual "Buscar na memória", movido pra esta seção) |

### Ordem do Palette ao digitar "/"
A ordenação atual é: **Modos → Memória → Skills → Ações**. Deve passar a ser:

1. **Ações** — code review, refactor, melhorar-ui, ler-pdf, ler-docx, analisar-imagem, explicar, debug, buscar-memoria
2. **Skills** — criar skill (já existe)
3. **Memória** — (se houver itens exclusivos de memória que não sejam buscar, manter aqui)
4. **Modos** — build, plan, simples, brain (já têm chips na UI, não precisam de destaque no palette)

### UX
- Digitar `/` abre o palette com as 4 seções na ordem acima
- Cada seção tem um cabeçalho leve (ex: "Ações", "Skills")
- Selecionar uma ação insere o comando no input ou executa diretamente
- Algumas ações pedem confirmação antes de executar (refactor, debug)

---

## 2. /init — Análise Inicial do Projeto

### Problema
Quando o usuário abre uma **pasta local nova** (um diretório no sistema de arquivos, não uma pasta de chat na sidebar) no modo código, o agente não tem contexto algum sobre o projeto — tecnologia, estrutura, convenções, regras de negócio. Tudo precisa ser descoberto via tentativa e erro, consumindo tokens e tempo.

### Solução
Sistema de **init automático e manual** que escaneia o projeto e gera memórias estruturadas por área de conhecimento.

### Gatilhos

#### Automático (card especial)
Quando uma nova sessão de código é aberta apontando pra uma pasta local que **não tem nenhum chat anterior referenciando ela como diretório principal**, um card é exibido no chat dizendo que é um projeto novo e sugerindo a análise. O card é visual, clicável — diferente dos comandos `/` que são textuais. Esse é o único caso onde usamos card em vez de comando.

#### Manual
Comando `/init` no palette (lista na seção de Ações).

### Pipeline do Init
1. **Scanner** — analisa estrutura de diretórios, arquivos de configuração (package.json, Cargo.toml, tsconfig, Dockerfile, etc.) e identifica:
   - Stack tecnológica (React, Node, Rust, Python etc.)
   - Framework (Next, Express, Axum, Django etc.)
   - Ferramentas (ESLint, Prettier, Biome, Ruff, etc.)
   - Estrutura de módulos/features
   - Presença de testes e tipo (vitest, pytest, cargo test)
   - Infraestrutura (Docker, CI/CD, docker-compose)

2. **Geração de Memórias por Área** — cria arquivos MD separados para cada domínio, salvos como memórias vinculadas ao projeto:

   | Área | Conteúdo |
   |------|----------|
   | **Contexto do Projeto** | Propósito, stack, estrutura geral, links úteis |
   | **Regras de Negócio** | Lógica central, fluxos, entidades, regras críticas |
   | **Design System** | Componentes UI, padrões visuais, acessibilidade |
   | **Arquitetura** | Módulos, comunicação entre serviços, dados |
   | **Preferências** | Estilo de código, convenções de nomeação, branching |
   | **Infraestrutura** | Deploy, variáveis de ambiente, CI/CD, containers |
   | **Segurança** | Autenticação, autorização, dados sensíveis |
   | **Desenvolvimento** | Scripts, comandos, setup local |

   Cada arquivo é salvo como uma memória separada com tag referenciando o projeto. Assim o agente carrega **só a área relevante** pro contexto (se vai alterar UI, lê Design System; se vai tocar em deploy, lê Infraestrutura), em vez de um único arquivo gigante com tudo.

3. **Vinculação ao Projeto** — cada memória fica associada ao caminho absoluto da pasta local. Quando o agente opera naquela pasta, ele consulta o grafo de memórias e carrega apenas os nodes relevantes pra tarefa atual.

### Re-init
- Comando `/init --update` ou `/init --force` para re-scanear quando o projeto muda significativamente
- Memórias existentes são **atualizadas com merge** — o novo scan preserva edições manuais do usuário e só sobrescreve seções que mudaram

---

## 3. Graph de Memórias

### Problema
Hoje as memórias no modo Árvore são uma lista linear na UI. Não dá pra ver como se relacionam, qual pertence a qual projeto, ou qual está desatualizada. Para o agente escolher a memória certa de forma eficiente, precisa entender o **grafo de dependência** entre elas.

### Solução
Visualização em **grafo**, onde:

- **Node central** é o projeto (pasta local)
- **Nodes satélite** são as áreas de conhecimento (design, arquitetura, regras de negócio, etc.)
- **Nodes soltos** são memórias avulsas criadas pelo usuário ou agente, conectadas ao projeto ou entre si
- **Arestas** representam relações: "depende de", "relacionado a", "contradiz"

### Funcionalidades

#### Navegação
- Zoom + pan no grafo
- Clicar num node abre a memória no painel ao lado
- Busca textual dentro dos nodes

#### Hierarquia
- Projeto no centro, áreas ao redor, sub-áreas como filhos das áreas
- Memórias soltas ficam na periferia

#### Estado Visual
- Node destacado se recentemente lido/atualizado
- Node opaco se desatualizado (projeto mudou desde a última edição)
- Aresta tracejada se relação inferida (não explícita)

#### Criação
- Arrastar um arquivo pro grafo cria um node de memória automaticamente
- Ctrl+click em dois nodes cria uma aresta entre eles

#### Contexto para o Agente
- O grafo não é só visual — o agente consulta a estrutura pra decidir quais memórias carregar
- Dado um prompt "muda a cor do botão", o agente navega: Projeto → Design System → encontra node de botões
- Isso reduz drasticamente o contexto injetado, porque o agente só puxa o subgrafo relevante

### Integração com /init
O `/init` popula o grafo automaticamente: cria o node central + nodes de área + arestas iniciais. O usuário pode depois adicionar, remover ou religar manualmente.

---

## Considerações Finais

### Valor vs Esforço

| Item | Esforço | Impacto | Prioridade |
|------|---------|---------|------------|
| Reordenação do palette "/" | Pequeno | Médio | 0 |
| Comandos "/" (primeiras 5 ações) | Médio | Alto | 1 |
| /init scanner + geração de memórias | Médio | Alto | 1 |
| Card de boas-vindas (/init automático) | Pequeno | Alto | 1 |
| Memórias por área (backing do /init) | Pequeno | Alto | 2 |
| Graph de memórias | Grande | Médio | 3 |
| Comandos "/" (restante) | Pequeno | Médio | 2 |

### Ordem Sugerida

0. **Reordenação do palette "/"** — mexer só a UI, sem pipeline novo
1. **Comandos "/"** — code review, refactor, melhorar-ui, ler-pdf, buscar-memoria
2. **/init** — scanner + card automático + geração de memórias por área
3. **Graph** — visualização com navegação e busca
