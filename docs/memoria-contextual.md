# Memória contextual: recuperação por embeddings + híbrida

Implementação e medição do mecanismo que injeta memórias no contexto do Orbit
com base na mensagem do usuário, em vez de injetar um bloco fixo por peso.

**Status (24/10/2026):** a validação final com um conjunto bloqueado **reprovou
a injeção automática** no critério pré-registrado (precisão ≥ 98% com IC95
inferior ≥ 90%). O bloco automático de memória fica **desligado por padrão**
(`ORBIT_MEMORY_AUTO_CONTEXT=1` liga); a memória continua disponível sob demanda
por `memory_search`/`memory_open`. A comparação de modelos também mudou de
sentido no conjunto independente: leia a **seção 13** antes de usar as
conclusões das seções 5 e 7. O restante do documento continua válido como
registro do que foi medido em cada etapa.

---

## 1. O que foi implementado

| Arquivo | Papel |
|---|---|
| `packages/shared/src/memory-retrieval.ts` | Texto de índice enriquecido, tokens Unicode, BM25, RRF, assinatura do índice |
| `packages/shared/src/memory-select.ts` | Candidatos (semântico/lexical/fusão), piso de ruído do acervo, política de dois níveis |
| `packages/shared/src/memory-query.ts` | Consulta contextual (mensagem + turno anterior) e quando vale refazê-la |
| `packages/shared/src/memory.ts` | Campos de enriquecimento no `Memory` (`title`, `summary`, `entities`, `keywords`, `concepts`) |
| `apps/desktop/electron/memory-embed/engine.mjs` | Bekko no `onnxruntime-node` direto (sem transformers.js), pooling por média, Matryoshka 256, L2 |
| `apps/desktop/electron/memory-embed/tokenizer.mjs` | Tokenizer BPE compacto (`tokenizer.bin`, 9,4 MB) — o `tokenizer.json` de 34 MB não é lido no runtime |
| `apps/desktop/electron/memory-embed/worker.mjs` | `utilityProcess` que carrega o modelo e responde embeddings |
| `apps/desktop/electron/lib/memory/embedding.ts` | Ciclo de vida do worker, índice persistido, reindexação incremental, download do modelo |
| `apps/desktop/electron/lib/memory/retrieval.ts` | Recuperação do turno, política de dois níveis, bloco do prompt |
| `apps/desktop/electron/lib/memory/service.ts` | Pool por modo, `retrieveForTurn`, sincronização em segundo plano |
| `apps/desktop/electron/lib/chat-engine.ts` | Injeta o bloco na mensagem do usuário do turno |
| `apps/desktop/electron/lib/memory/bench/*` | Benchmark versionado (fixtures sintéticas, harness, experimentos) |

O bloco de memória entra **na última mensagem do usuário**, não no system prompt:
o system é congelado por sessão para o cache de prefixo dos provedores, e mudá-lo
a cada pergunta jogaria esse cache fora.

---

## 2. Esquema e indexação

O texto indexado (`buildRetrievalText`) combina, nesta ordem e sem inventar
nada que não esteja na memória:

1. título (do LLM; senão a primeira oração do texto);
2. conteúdo original **inteiro** (é a fonte da verdade);
3. resumo, entidades, palavras-chave e conceitos, só quando trazem termo novo.

Limite de 700 caracteres: passando disso, os extras são cortados primeiro — o
conteúdo original nunca. Rótulo de idioma não entra: a memória pode estar em
qualquer língua e os modelos são cross-lingual.

Cada vetor carrega uma **assinatura** (`indexSignature`) que inclui versão do
esquema, modelo, dimensões e o texto de índice. Mudou qualquer um deles ⇒ a
memória fica elegível para reindexação, feita em segundo plano, em lotes de 16,
gravada após cada lote (interromper não perde o que já foi feito).

Memória apagada sai do índice na próxima sincronização; memória cujo texto passa
do orçamento de injeção (600 caracteres) não é descartada — vira ponteiro.

---

## 3. Benchmark

Fixtures **sintéticas e versionadas** (nenhum dado real):

- `bench/corpus.json` — 61 memórias de uma usuária fictícia, em português,
  inglês, espanhol, japonês e russo; tipos `pref`, `travel`, `episodic`,
  `entity`, `project`, `tool`, `short`, `distractor`.
- `bench/cases.json` — 218 consultas rotuladas (108 **dev** / 110 **eval**),
  com memórias relevantes, o resultado esperado (`inject`/`pointer`/`none`) e o
  motivo. Tipos: paráfrase, sinônimo, pergunta indireta, correspondência
  lexical exata, sem palavra em comum, tema vizinho (não exige memória) e fora
  de assunto.
- `bench/dialogs.json` — 18 mensagens que não se explicam sozinhas, com o
  contexto anterior e a reescrita ideal.

Regras de método: **toda calibração usa só o split dev**; o split eval nunca é
lido para ajustar parâmetro. As sondas de ruído do acervo
(`NOISE_PROBES`, 37 perguntas genéricas) foram escritas à parte — um teste
garante que nenhuma delas aparece em `cases.json`.

Comando (carrega o ONNX do cache local, ~6 s):

```bash
cd apps/desktop
MEMORY_BENCH=1 npx vitest run electron/lib/memory/bench/eval.test.ts
```

Resultados gravados em `apps/desktop/.cache/memory-embed/results/bekko-<id>.json`.

---

## 4. Ranking (Fase 3) — split eval, 81 consultas com memória relevante

| Experimento | R@1 | R@3 | R@5 | MRR | AUC |
|---|---:|---:|---:|---:|---:|
| lexical atual (`searchMemories`) | 43,2% | 51,9% | 54,3% | 0,477 | — |
| BM25, texto enriquecido (com LLM) | 48,1% | 54,3% | 55,6% | 0,515 | — |
| semântica, representação antiga | 87,7% | 96,3% | 96,3% | 0,920 | 0,628 |
| semântica, enriquecida (só determinística) | 87,7% | 97,5% | 97,5% | 0,922 | 0,652 |
| semântica, enriquecida (com LLM) | 92,6% | 97,5% | 98,8% | 0,953 | 0,679 |
| híbrido RRF, peso lexical igual (ingênuo) | 60,5% | 74,1% | 86,4% | 0,706 | 0,679 |
| **híbrido RRF, fusão calibrada** | **93,8%** | **97,5%** | **98,8%** | **0,959** | **0,679** |

(valores do a8m; o a25m tem a mesma forma — ver §7)

Três achados que mudaram a implementação:

1. **A busca lexical isolada é fraca** (R@1 43%) e não pode ser a espinha
   dorsal: ela não atravessa paráfrase nem idioma.
2. **Fusão com peso igual é pior que o semântico sozinho** (R@1 60,5% contra
   92,6%). Um acerto lexical de um token só empata em posição com o melhor
   semântico e ganha por desempate de id. Corrigido com peso lexical 0,1 **e**
   um corte de cobertura (só entra na fusão o acerto lexical que cobre ≥ 0,5 do
   IDF da consulta). Com isso o híbrido **nunca perde** para o semântico e
   chega a ganhar (93,8% contra 92,6% no a8m).
3. **O enriquecimento vale ~5 pontos de R@1.** Quando o LLM que grava a
   memória preenche título/entidades/conceitos, o ganho é maior do que o da
   versão só determinística — e o custo é quase zero, porque quem chama o
   modelo já tem o texto. Por isso `memory_save` (chat e código) agora aceita
   esses campos.

### Recorte do eval (fusão calibrada)

| Recorte | a8m R@1 / R@5 | a25m R@1 / R@5 | n |
|---|---|---|---:|
| mesmo idioma (consulta e memória) | 100% / 100% | 100% / 100% | 21 |
| idioma diferente | 92% / 98% | 97% / 98% | 60 |
| consulta en | 94% / 97% | 97% / 97% | 31 |
| consulta es | 94% / 100% | 100% / 100% | 17 |
| consulta pt | 92% / 100% | 96% / 100% | 26 |
| consulta ja | 100% / 100% | 100% / 100% | 4 |
| consulta ru | 100% / 100% | 100% / 100% | 3 |
| memória `travel` | 92% / 100% | 100% / 100% | 13 |
| memória `short` (curta, depende de contexto) | 86% / 100% | 100% / 100% | 7 |
| memória `pref` | 93% / 93% | 93% / 93% | 15 |
| memória `project` | 91% / 100% | 100% / 100% | 11 |

O contraste que importa: **mesmo idioma 100% × idioma diferente 92% (a8m) em
R@1**. Recuperar memória em outro idioma funciona, mas o topo é menos confiável —
e é justamente aí que o ponteiro (em vez da injeção) faz diferença.

## 5. Consulta contextual (Fase 4) — 16 diálogos com memória relevante

| Modo | topo correto | injetou | limpas |
|---|---:|---:|---:|
| 1. mensagem isolada | 7/16 | 0/9 | 2/2 |
| 2. mensagem + contexto (sempre) | 12/16 | 3/9 | 2/2 |
| 3. reescrita ideal (limite superior) | 15/16 | 4/9 | 2/2 |
| **4. contexto só se a busca isolada falha** | **12/16** | **3/9** | 2/2 |

O modo 4 é o que foi implementado: só refaz a busca com o contexto quando a
mensagem é curta, existe turno anterior e a busca isolada **não achou nada**.
Isso dá o mesmo resultado do modo 2 sem herdar assunto antigo — o caso "troca de
assunto" (`d02`) continua não sendo poluído pelo turno anterior.

A reescrita ideal (modo 3) mostra o teto: com reescrita, 15/16 no topo contra
7/16 isolada. A expansão por LLM não foi implementada como etapa obrigatória —
o modo 4 captura a maior parte do ganho sem chamada extra por mensagem.

---

## 6. Política de dois níveis (Fase 5)

### O sinal não separa por cosseno absoluto

Distribuição de cossenos no split **dev** (a8m):

| Cossenos | p10 | p25 | p50 | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|
| consultas que PEDEM memória (`inject`) | 0,359 | 0,446 | 0,559 | 0,633 | 0,692 | 0,779 |
| topo das consultas que NÃO precisam (`none`) | 0,226 | 0,289 | 0,376 | 0,476 | 0,628 | 0,680 |
| consultas de `pointer` | 0,340 | 0,358 | 0,415 | 0,479 | 0,536 | 0,582 |
| piso de ruído (sondas genéricas) | 0,165 | 0,200 | 0,242 | 0,273 | 0,312 | 0,422 |

As caudas se sobrepõem: em qualquer limiar com recall útil, 10–30% das consultas
"sem memória" também disparam. E **as consultas de `pointer` têm cosseno
parecido com as de `none`** — elas não se separam do ruído. Isso é resultado, não
defeito: "pode ajudar" e "não precisa" são a mesma coisa para um modelo de
similaridade.

### Regras comparadas (dev, 79 positivas, 29 sem memória)

| Regra | Injetou (acertou) | FP | FP em tema vizinho |
|---|---:|---:|---:|
| cosseno ≥ 0,50 | 39/79 | 7/29 | 7/19 |
| cosseno ≥ 0,60 | 24/79 | 4/29 | 4/19 |
| cosseno ≥ 0,65 | 12/79 | 2/29 | 2/19 |
| cos ≥ 0,50 + margem ≥ 0,05 | 39/79 | 7/29 | 7/19 |
| cos ≥ 0,50 + cobertura lexical ≥ 0,6 | 12/79 | 1/29 | 1/19 |
| cos ≥ piso de ruído + 0,20 | 22/79 | 4/29 | 4/19 |
| cos ≥ piso de ruído + 0,27 | 6/79 | 0/29 | 0/19 |
**Margem não ajuda** (0,05 muda uma consulta; 0,08 muda duas). O que ajuda é
**cobertura lexical**: quando o acervo tem o termo exato, o acerto é quase certo.
Por isso a família escolhida combina piso de ruído do acervo + cobertura lexical.

### Política implementada

- **Injeção automática:** cosseno ≥ (piso de ruído do acervo + 0,22) — ou
  cobertura lexical ≥ 0,7 com cosseno acima do piso de ponteiro. No máximo 3
  memórias, só as que estão a até 0,10 de cosseno do topo.
- **Ponteiro:** cosseno ≥ piso de ruído, no máximo 2, em uma linha
  `#mem_id — título`. O modelo abre com `memory_open` se fizer falta.
- **Nada:** fora disso, nenhum caractere entra no contexto.
- **Fora do mecanismo:** memórias `core` e as instruções persistentes continuam
  no bloco fixo do prompt.

### Resultado da seleção (a25m / a8m, split eval, 110 consultas)

| Métrica | a25m | a8m |
|---|---:|---:|
| consultas `inject` com memória injetada | 21/70 | 21/70 |
| memórias injetadas irrelevantes (FP) | 3 | 4 |
| entre as 29 consultas sem memória: limpas | 21/29 | 21/29 |
| ponteiros úteis nas consultas `pointer` | 3/11 | 0/11 |
| ponteiros emitidos que não eram relevantes | 3 | 4 |

Leitura honesta: **a injeção automática é conservadora e precisa** (3–4 falsos
positivos em 29 consultas sem memória), mas cobre só ~30% das consultas
rotuladas `inject`. O ponteiro, no split de avaliação, quase não aparece — ele é
calibrado no dev, onde recupera 4–5 de 21. Preferi errar por omissão: o plano
manda ser conservador quando nenhuma regra atinge a precisão necessária.

#### Tabela de contingência completa (eval = 81 positivas + 29 sem memória = 110)

| a8m | consultas | memórias |
|---|---:|---:|
| `inject` com a memória certa injetada | 21/70 | 21/70 relevantes |
| `inject` rebaixada para ponteiro | 11/70 | — |
| `pointer` com ponteiro útil | 0/11 | — |
| `pointer` com a memória injetada | 0/11 | — |
| injeções irrelevantes (total) | 4 | em 25 injetadas |
| — em consultas positivas (idioma cruzado) | 1 | |
| — em consultas sem memória | 3 | |
| ponteiros irrelevantes | 4 | em 20 emitidos |
| consultas sem memória que não receberam nada | 21/29 | |
| consultas sem memória que receberam só ponteiro | 5/29 | |

a25m: 21/70 injetadas, 20 rebaixadas, 3/11 ponteiros úteis, 3 injeções
irrelevantes (todas em consultas sem memória), 3 ponteiros irrelevantes em 31.

#### Recorte por idioma da consulta vs idioma da memória (eval, a8m / a25m)

| grupo | injetou | FP | ponteiro útil | limpas |
|---|---:|---:|---:|---:|
| idioma diferente (n=60) | 14/51 · 12/51 | 1 · 0 | 0/9 · 3/9 | — |
| mesmo idioma (n=21) | 7/19 · 9/19 | 0 · 0 | 0/2 · 0/2 | — |
| sem memória necessária (n=29) | — | 3 · 3 | — | 21/29 · 21/29 |

A cobertura lexical **não é barreira entre idiomas**: em `memory-select.ts:284`
ela só *acrescenta* um caminho de injeção (`cos >= pointerT && coverage >= 0,7`),
nunca condiciona o caminho puramente semântico. Os números confirmam: das 51
consultas cruzadas rotuladas `inject`, 14 (a8m) e 12 (a25m) foram injetadas, e o
único falso positivo cruzado apareceu no a8m. O que separa os dois grupos é o
tamanho da amostra (19 consultas no mesmo idioma), não uma penalidade lexical.

---

## 7. a8m × a25m na solução completa

Mesma estrutura de memórias, mesmos parâmetros, mesmas consultas, mesmos pesos
de runtime. Split eval (81 positivas, 29 negativas):

| Métrica (eval) | a8m | a25m | Δ |
|---|---:|---:|---:|
| R@1 (fusão calibrada) | 93,8% | 97,5% | −3,7 pp |
| R@3 | 97,5% | 98,8% | −1,3 pp |
| R@5 | 98,8% | 98,8% | **0 pp** |
| MRR | 0,959 | 0,983 | −0,024 |
| AUC | 0,679 | 0,719 | −0,040 |
| injeções corretas (eval) | 21/70 | 21/70 | 0 |
| falsos positivos (eval) | 4 | 3 | +1 |
| ponteiros úteis (eval) | 0/11 | 3/11 | −3 |
| consultas limpas (de 29) | 21 | 21 | 0 |

Contagens absolutas: R@1 é 4 casos de diferença em 81.

**Incerteza** (bootstrap pareado, 4.000 reamostragens sobre os casos de eval):

- ΔR@1 (a8m − a25m): mediana **−3,6 pp**, IC95 **[−7,3; 0,0]**.
- ΔAUC (a8m − a25m): mediana **−0,044**, IC95 **[−0,111; +0,023]** — inclui
  zero.

Convenção de sinal: Δ = a8m − a25m, então **negativo = a8m abaixo**. Os dois
números do AUC (−0,040 na tabela, −0,044 na mediana do bootstrap) são a mesma
diferença medida de duas formas: o valor pontual sai da conta direta sobre os 110
casos; a mediana sai da distribuição de 4.000 reamostragens pareadas e carrega o
viés próprio do bootstrap. Mesmo sinal, mesma leitura.

#### O split de avaliação ficou independente?

Os limiares são escolhidos por código **apenas** em `dev` (`analysis.ts:231` e
`analysis.ts:447` filtram `split === 'dev'`; `eval` só é lido para reportar).
Teste de sensibilidade: calibrar no `eval` e medir no `dev` escolheu a **mesma
família de regras** (F) e devolveu os mesmos números no `dev` — 26/58 injetadas,
5 FP, 4/21 ponteiros (a8m); 30/58, 4 FP, 5/21 (a25m). Os limiares andam pouco
(`injectDelta` 0,22 → 0,25 no a8m; 0,22 → 0,19 no a25m).

O que isso **não** cobre: eu olhei os resultados de `eval` entre iterações para
decidir *quais famílias de regra existiriam*, então `eval` não é um conjunto
virgem — é um conjunto que não participou do ajuste de parâmetros, mas
participou do desenho. A correção definitiva é escrever um terceiro lote de
consultas que ninguém viu; está listado nas limitações.

Ou seja: a vantagem do a25m tem sinal consistente, mas **não é demonstrada** com
este tamanho de amostra. Por categoria, o a25m nunca fica atrás e ganha 1–2 casos
em cinco recortes (en 94→97, es 94→100, pt 92→96, `travel` 92→100, `short`
86→100); em todos os outros empata. A direção é consistente; a magnitude é de 1 a
2 casos por recorte.

### Regra de decisão aplicada

| Critério do plano | Resultado |
|---|---|
| ΔRecall@5 ≤ ~3 pp | **0 pp** ✅ |
| ΔAUC ≤ ~0,03 (em módulo) | \|ΔAUC\| = 0,040 no ponto, IC inclui zero — ⚠️ limítrofe |
| Sem regressão consistente por idioma/tipo | ✅ (diferenças isoladas) |
| Ambos atingem precisão de injeção | ✅ (4 vs 3 FP em 29) |

**Decisão: a8m.** O AUC do a25m é 0,040 maior no ponto — 0,01 acima da margem
que o plano sugere — mas o intervalo de confiança cruza zero, o R@5 (a métrica
que importa para recuperar mais de uma memória) é idêntico e as métricas de
seleção são as mesmas. A vantagem real é de 4 consultas em 81, contra ~75 MB a
mais de RAM residente, 3× o tempo de indexação e 2,5× a latência de consulta em
toda mensagem.

Leitura estrita: se o critério de ΔAUC ≤ 0,03 for aplicado no ponto (e não no
intervalo), o a25m passa. A troca é uma constante — `MEMORY_MODEL_ID` e
`MEMORY_MODEL_DIM` em `electron/lib/memory/embedding.ts` — mais a reindexação,
que a assinatura dispara sozinha. Não mantenho os dois no produto: a comparação
é experimento, não arquitetura.

> **Revisão de 24/10 (seção 13.3):** esta decisão vale para o **ranking na
> fixture de ajuste**. No conjunto bloqueado independente o a25m fica à frente
> de forma consistente — AUC 0,645 × 0,547 e R@1 +7 a +14 pp nos recortes de
> idioma cruzado e contexto — com R@5 empatado. Como a injeção automática está
> desligada, o a8m continua sendo o padrão de runtime (custo menor); se a
> injeção for reativada, o a25m precisa ser reavaliado primeiro. A decisão de
> modelo **não está fechada**.

---

### Fumação no acervo real (311 memórias, sem rótulos)

O benchmark acima usa fixture sintética. Para checar se o **índice que vai rodar
de verdade** se comporta na mesma faixa, `bench/real.test.ts` monta o índice com
as memórias reais do app (`~/Library/Application Support/@orbit/desktop/...`) e
não imprime texto nenhum — só id, rótulos de classificação e cosseno.

| Medida | Valor |
|---|---|
| memórias indexadas | 311 |
| `retrievalText` vazio | 0 |
| tamanho do texto indexado | p50 331 · p90 675 · máx 6.195 caracteres |
| indexação completa | **1,68 s** (mediana de 3; 5,4 ms/memória) |
| RSS no processo de teste | 332–479 MB |
| piso de ruído (máx. das sondas) | **0,433** (fixture: 0,418) |
| cosseno médio entre pares de memórias | 0,308 (máx. 0,907) |

A faixa de cosseno do acervo real **é a mesma da calibração** (piso 0,43 contra
0,42), então os limiares não foram ajustados a uma escala que não existe em
produção. O par de 0,907 indica memórias quase duplicadas — elas ocupam as duas
primeiras posições e são candidatas naturais a "ponteiro irrelevante"; vale
deduplicar o acervo ao gravar.

Nove sondas genéricas escritas para o teste (nenhuma vem do acervo):

| sonda | cosseno do topo | decisão | rótulo do topo |
|---|---:|---|---|
| preferências de resposta | 0,524 | ponteiro | project/preference/preferences |
| como prefiro o código | 0,484 | ponteiro | project/preference/preferences |
| como está o deploy | 0,488 | ponteiro ×2 | project/structure/overview |
| que modelo de IA uso | 0,481 | ponteiro | project/decision/overview |
| qual banco de dados | 0,382 | nada | project/decision/architecture |
| quais projetos toco | 0,341 | nada | project/structure/overview |
| fuso horário | 0,330 | nada | seasonal |
| capital da Austrália | 0,177 | nada | — |
| 45 ÷ 9 | 0,286 | nada | — |

Nenhuma sonda chegou ao limiar de injeção (0,653) — coerente: são perguntas
genéricas, não fatos que exijam memória. **Isto é uma fumação estrutural, não
medida de qualidade**: sem rótulos não há precisão nem recall no acervo real, e
os rótulos de categoria são só um indício de que a busca achou o assunto certo.

---

## 8. Custo real (mediana de 3 execuções, processo limpo, modelo + tokenizer)

| | a8m | a25m |
|---|---:|---:|
| Arquivo do modelo | 130 MB | 199 MB |
| RSS com o modelo carregado | **390 MB** | **465 MB** |
| Δ de RSS do modelo (sobre o processo vazio) | 342 MB | 417 MB |
| RSS com índice de 60 memórias | 401 MB | 476 MB |
| Tokenizer compilado | 9,4 MB | 9,4 MB (idêntico) |
| Tempo de carregamento | 70 ms (disco frio: 167 ms) | 141 ms (frio: 206 ms) |
| Indexação por memória | **1,4 ms** | 3,6 ms |
| Consulta: mediana / p95 | **1,0–1,2 ms / 2,0 ms** | 3,0 ms / 3,8 ms |
| Índice em disco (309 memórias, 256 dim, base64) | ~420 KB | ~420 KB |

O vetor é truncado para 256 dimensões (Matryoshka): 3× menos índice com perda
desprezível de ordenação.

Os dois modelos usam **o mesmo tokenizer** (sha256 idêntico entre os dois
`tokenizer.json`), então o `tokenizer.bin` é compilado uma vez só.

---

## 9. Integração no app

- O motor roda em `utilityProcess` (`memory-embed/worker.mjs`), nunca no main:
  carregar 130 MB de ONNX e rodar inferência no thread principal congelaria
  janelas e IPC.
- O worker se desliga sozinho após 5 minutos ocioso, devolvendo a RAM.
- A indexação roda em segundo plano: no startup (pelo scheduler) e depois de
  qualquer `memory_save`/`memory_update`/`memory_delete`, com debounce de 2 s.
  A conversa **nunca espera** a indexação.
- Fallback: sem modelo baixado, com o worker caído ou com o índice corrompido, a
  recuperação devolve **só ponteiros da busca lexical** — nunca injeta texto sem
  evidência — e o app continua funcionando.
- O modelo é baixado sob demanda para `<userData>/memory/models/bekko-a8m`;
  em desenvolvimento o app usa `apps/desktop/.cache/memory-embed/bekko-a8m`.

```bash
# baixa o modelo (130 MB) para a pasta do app
cd apps/desktop && npm run memory:model
# ou, para desenvolvimento (sem app):
npm run memory:model -- --dev
```

---

## 10. Testes

Determinísticos, sem modelo (rodam na suíte normal):

| Arquivo | Cobre |
|---|---|
| `electron/lib/memory/memory-retrieval.test.ts` (23) | tokens Unicode, enriquecimento, teto do índice, assinatura, BM25, RRF |
| `electron/lib/memory/select.test.ts` (20) | candidatos, piso de ruído, dois níveis, limites, margem |
| `electron/lib/memory/query.test.ts` (11) | consulta isolada/contextual, orçamento, quando refazer |
| `electron/lib/memory/retrieval.test.ts` (12) | recuperação do turno, ponteiro, fallback lexical, bloco do prompt |
| `electron/lib/memory/embedding.test.ts` (7) | índice: esquema, modelo trocado, corrupção, remoção, falha silenciosa |

Validação: `cd apps/desktop && npx tsc --noEmit && npx vitest run`
(2250 testes passando; `electron/lib/media-compress/compress.test.ts` depende de
ffmpeg).

---

## 11. Limitações e o que NÃO foi verificado

1. **Acervo sintético.** Tudo aqui foi medido em 61 memórias fictícias. O acervo
   real tem 311, muito mais técnico e com pares quase duplicados (cosseno 0,907).
   A fumação mostra que a *faixa* de cosseno é a mesma, mas **não há rótulos no
   acervo real**: não existe precisão nem recall medidos nele. A calibração
   precisa ser refeita com consultas reais rotuladas antes de considerar os
   limiares definitivos.
2. **`eval` não é um conjunto virgem.** Os limiares são ajustados só em `dev`
   (verificado por código e pelo teste de troca de split), mas eu olhei resultados
   de `eval` entre iterações para decidir *quais famílias de regra existiriam*.
   Falta um terceiro lote de consultas que ninguém viu.
3. **O split de avaliação tem 110 consultas** (81 positivas + 29 sem memória). É
   pouco para afirmar equivalência entre modelos: a diferença de R@1 é de 4 casos
   e o IC do ΔAUC cruza zero.
4. **Ponteiro fraco no eval** (0/11 no a8m, 3/11 no a25m). No dev ele recupera
   4–5 de 21. A razão é estrutural: as consultas `pointer` e `none` têm a mesma
   distribuição de cosseno, então não há limiar que separe as duas.
5. **Cross-lingual funciona, com amostra pequena.** No a8m, R@1 92% em idioma
   diferente (n=60) contra 100% no mesmo idioma (n=21) — a queda de 8 pp é 5
   casos. Na seleção, 14/51 consultas cruzadas foram injetadas, com 1 falso
   positivo. A cobertura lexical não bloqueia nada aqui: ela só acrescenta
   caminho de injeção, nunca condiciona o semântico.
6. **Expansão de consulta por LLM** não foi implementada — só a consulta
   contextual determinística (mensagem + turno anterior). A reescrita ideal
   (`3. reescrita ideal`) marca o limite superior: 16/16 no topo contra 4/16 da
   mensagem isolada, ou seja, há ~12 casos de ganho deixados na mesa.
7. **Empacotamento não verificado.** O modelo é baixado em runtime e fica fora do
   `asar`; **não** testei o build assinado, o Mac App Store, nem máquinas fracas
   (os números são de um Apple M5 com a máquina livre).
8. **Memórias já existentes** ganham título/entidades/conceitos só quando forem
   regravadas; não há uma passada de LLM para enriquecer as 311 antigas — o
   índice delas usa o enriquecimento determinístico. Uma memória de 6.195
   caracteres tem o texto truncado em 512 tokens pelo embedding.
9. **Indexação inicial real medida**: 1,68 s para 311 memórias (mediana de 3),
   em segundo plano e sem bloquear a conversa. Sob contenção de CPU (outro
   processo pesado na máquina) a mesma carga levou 6,4 s.

---

## 12. Como reproduzir

```bash
cd apps/desktop

# 1. typecheck + suíte completa
npx tsc --noEmit && npx vitest run

# 2. benchmark real (a8m e a25m; grava JSON em .cache/memory-embed/results/)
MEMORY_BENCH=1 npx vitest run electron/lib/memory/bench/eval.test.ts

# 3. custo (RAM, latência, indexação) — rodar 3x e usar a mediana
node scripts/memory-bench-rss.mjs a8m
node scripts/memory-bench-rss.mjs a25m

# 4. baixar o modelo para o app
npm run memory:model

# 5. fumação no acervo REAL (só id, rótulo e cosseno — nunca o texto)
MEMORY_BENCH_REAL=1 npx vitest run electron/lib/memory/bench/real.test.ts
```

Os modelos vêm de `huggingface.co/hotchpotch/bekko-embedding-v1-a8m` (MIT) e
`...-a25m`. Os resultados de Arctic, E5 e do modelo estático ficam fora desta
suíte: foram medidos antes, com outra fixture, e não participam das comparações.

---

## 13. Validação final (24/10/2026) — conjunto bloqueado e auditoria da seleção

Esta seção substitui as conclusões das seções 5 e 7 onde elas conflitarem.
Tudo aqui foi produzido por `bench/audit.test.ts`, que **não calibra nada**:
aplica políticas pré-registradas em `bench/policy.ts` e mede.

### 13.1 Auditoria dos denominadores e da matriz de confusão

Denominadores da fixture de ajuste, conferidos no runner e na fixture:

| conjunto | consultas | com memória relevante | `inject` | `pointer` | sem memória |
|---|---:|---:|---:|---:|---:|
| eval | 110 | 81 | 70 | 11 | 29 |
| dev | 108 | 79 | 58 | 21 | 29 |
| bloqueado (novo) | 35 + 3 diálogos | 22 | 14 | 8 | 12 |

`relevant` é sempre lista de ids; `expect` é o que o caso **exige**
(`inject` = conteúdo completo, `pointer` = ponteiro basta, `none` = nada).
A matriz agora trata consulta `none` corretamente: **qualquer** memória é ruído,
então uma injeção conta como `inject` e um ponteiro como `pointer`, mesmo sem
memória relevante existir.

Matriz do eval com a política calibrada (P1, limiares absolutos 0,60/0,50):

| esperado → decidido | inject | pointer | nada |
|---|---:|---:|---:|
| inject (a8m) | **21** | 11 | 38 |
| pointer (a8m) | 0 | **0** | 11 |
| none (a8m) | 3 | 5 | **21** |
| inject (a25m) | **21** | 20 | 29 |
| pointer (a25m) | 0 | **3** | 8 |
| none (a25m) | 3 | 5 | **21** |

Precisão por **memória injetada** (é ela que decide injeção, não o ranking):
a8m **21/25 = 84,0%** IC95 [65,3; 93,6]; a25m **21/24 = 87,5%** IC95 [69,0; 95,7].
O limite superior do IC já fica abaixo da meta de 98%.

As quatro injeções irrelevantes do a8m, com o caso e o cosseno:

| caso | esperado | injetou | cosseno | era para injetar |
|---|---|---|---:|---|
| q078 | inject | m022 (app Pixel) | 0,555 | m026 (chave do Sentry do Pixel) |
| q210 | none | m027 (convenção de commits) | 0,699 | — |
| q226 | none | m052 (alergia a camarão) | 0,612 | — |
| q234 | none | m014 (corre de manhã) | 0,652 | — |

Os três últimos são o caso difícil previsto no plano: a pergunta é **sobre o
assunto** da memória, e não precisa dela. "Quais os sintomas de alergia a
camarão?" casa a 0,61 com "Alérgica a camarão"; "qual o melhor horário para
correr?" casa a 0,65 com "gosta de correr de manhã".

### 13.2 Por que nenhum ponteiro útil apareceu — e por que corrigir não bastou

A forense mostra que a recuperação **não** era o problema: entre os 11 casos
`pointer` do eval, a memória certa estava em 1º lugar por cosseno em 7 (a8m) e
8 (a25m). O problema era o limiar:

| caso (a8m) | cosseno da memória certa | limiar de ponteiro | candidatos acima |
|---|---:|---:|---:|
| q002 | 0,379 | 0,50 | 0 |
| q054 | 0,373 | 0,50 | 0 |
| q080 | 0,471 | 0,50 | 0 |
| q114 | 0,472 | 0,50 | 0 |
| q124 | 0,486 | 0,50 | 0 |
| q130 | 0,440 | 0,50 | 0 |
| q140 | 0,454 | 0,50 | 0 |
| q158 | 0,497 | 0,50 | 0 |

**Nenhum candidato de nenhuma dessas consultas passava de 0,50.** Não era
`maxPointers`, não era fusão de ranking, não era rótulo errado (todos os ids
existem na fixture) — era o limiar acima de toda a distribuição.

Correção aplicada: calibrar o nível de ponteiro **separadamente**, no dev
(`pointerCos 0,49`, top-1, teto de 25% de negativas com ponteiro). No eval ela
recupera 5/21 casos de ponteiro no dev. **No conjunto bloqueado, porém, o
resultado foi 0/8 úteis (a8m) e 1/8 (a25m), tocando 5/12 e 3/12 consultas sem
memória.**

A razão aparece nos cossenos do bloqueado: os casos em que a memória **ajudaria**
têm cosseno 0,24–0,49, enquanto as perguntas **sobre o mesmo assunto que não
precisam de memória** ficam em 0,60–0,70. Ou seja: "vai ajudar" e "é do mesmo
tema" não se separam por similaridade — e o sinal aponta na direção errada.
Isso não é um defeito do Bekko; é a natureza da tarefa.

### 13.3 Conjunto bloqueado (independente)

16 memórias e 35 consultas + 3 diálogos autorais, de cenários que **não existem**
na fixture de ajuste (glúten, billing em D1, reunião de março, Barcelona,
reunião de manhã em japonês, Postgres em russo, irmã no Porto, deploy às
quintas, bicicleta Bianchi, rinite, staging, etc.). Inclui paráfrase, sinônimo,
indireta, cruzada entre idiomas, identificador exato, contexto de diálogo,
negativo difícil e fora de assunto. Nenhuma memória da fixture principal foi
reutilizada, para não haver paráfrase atravessando os conjuntos.

Ranking (fusão calibrada, `full`):

| recorte | a8m R@1 | a8m R@5 | a25m R@1 | a25m R@5 |
|---|---:|---:|---:|---:|
| mesmo idioma (n=20) | 85% | 100% | 90% | 100% |
| **idioma diferente (n=15)** | **53%** | 87% | **67%** | 87% |
| pt (n=27) | 67% | 93% | 74% | 93% |
| paráfrase (n=5) | 80% | 100% | 100% | 100% |
| cruzada (n=4) | 75% | 100% | 100% | 100% |
| contexto (n=8) | 50% | 100% | 62% | 100% |
| negativo difícil (n=9) | 89% | 89% | 89% | 89% |
| fora de assunto (n=3) | 0% | 67% | 0% | 67% |

AUC no bloqueado: **a8m 0,547** (praticamente aleatório) × **a25m 0,645**.
No eval: 0,679 × 0,719.

Escada de decisão pré-registrada, avaliada uma vez no bloqueado:

| política | injeções corretas | precisão | ponteiros úteis | sem-memória tocadas | veredito |
|---|---|---:|---:|---:|---|
| P1b injeção calibrada + ponteiro próprio (a8m) | 10/10 | 100% | 0/8 | 5/12 | **reprovada** (IC95 72–100 < 90) |
| P3 injeção estrita (cos ≥ 0,94) | 7/7 | 100% | 0/8 | 5/12 | **reprovada** (amostra) |
| P2 somente ponteiros | 0/0 | — | 0/8 | 5/12 | segura, mas sem valor medido |

A regra era: precisão ≥ 98% **e** IC95 inferior ≥ 90%. Nenhuma passou. Com
n=10 sem erro, o IC95 inferior é 72% — não há como afirmar 98% com essa amostra.
**Consequência:** `AUTO_CONTEXT_ENABLED = false` em `lib/memory/service.ts`;
o bloco automático não entra no contexto por padrão.

### 13.4 Multilíngue: a cobertura lexical não bloqueia idioma cruzado

- No código, o caminho lexical da seleção **só acrescenta** injeção
  (`cos >= pointerT && coverage >= 0,7`); ele nunca condiciona o semântico. Não
  há barreira entre idiomas na política.
- Na fusão, o peso lexical calibrado é 0,1, com corte de cobertura 0,5. A
  ablação semântico × híbrido por idioma deu **resultado idêntico em todos os
  recortes do bloqueado** e quase idêntico no eval — a única diferença visível
  é `exact` no eval, que sobe de 95% para 100% com o híbrido (1 caso).
- Recuperação cruzada: eval 92% R@1 (a8m) / 97% (a25m); bloqueado 53% / 67%.
  A queda no bloqueado não vem do idioma: os casos cruzados lá são também os
  mais indiretos.

### 13.5 Acervo real (311 memórias, sem conteúdo no relatório)

| métrica | valor |
|---|---|
| memórias indexadas | 311 |
| tempo de índice | 1.716 ms (5,52 ms/memória) |
| RSS no processo de teste | 340 MB |
| `retrievalText` vazio | 0 |
| piso de ruído (máx. das 37 sondas) | **0,433** (sintético: 0,418) |
| cosseno entre memórias | média 0,307 · máximo 0,907 |

O piso de ruído real é praticamente o mesmo do sintético — a calibração não foi
feita numa escala irreal.

O par de 0,907 foi analisado **estruturalmente** (sem imprimir texto): Jaccard
de tokens 0,22, sem contenção de texto, mesmos `kind`/`category`/`area`/projeto.
Veredito: **tema próximo, fatos distintos — não é duplicata**. O mesmo vale para
os outros 4 pares acima de 0,85 (Jaccard 0,22–0,45). Não há nada para fundir ou
apagar automaticamente.

Como o acervo real **não tem ground truth**, não existe precisão nem recall
medidos nele. Foi criado o mecanismo de rotulagem local
(`~/.orbit-memory-review/queue.json` + `revisar.html`, fora do repositório),
que mostra as 5 memórias mais próximas de cada sonda e exporta `rotulos.json`
com "ajuda / talvez / não ajuda". É o pré-requisito para medir o acervo real —
e não foi preenchido por mim, porque isso exigiria ler o conteúdo.

### 13.6 Estado de testes e integração

| verificação | resultado |
|---|---|
| `npx tsc --noEmit` (apps/desktop) | limpo |
| testes do subsistema de memória | **85 passando**, 6 pulados (benchmarks com modelo) |
| suíte completa | **2.332 passando**, 1 falha intermitente (`design-store` watcher, 3 ms de timeout; passa isolada), 6 pulados |
| índice atualizado em criação/edição/exclusão | coberto em `embedding.test.ts` (9 testes) |
| falha do modelo → fallback lexical | coberto em `retrieval.test.ts` |
| reindexação não bloqueia | `syncIndex` roda fora do turno, por gatilho debounced |
| empacotamento assinado / MAS / máquina fraca | **não verificado** |

### 13.7 Limitações que impedem afirmar precisão

1. **O conjunto bloqueado tem 35 consultas.** 10/10 injeções corretas não
   sustentam 98% (IC95 inferior 72%). É preciso um acervo rotulado maior.
2. **O conjunto bloqueado foi escrito por mim**, sabendo como a política
   funciona. Não houve ajuste sobre ele, mas não é neutro como um conjunto
   rotulado por outra pessoa.
3. **Não existe ground truth no acervo real**; a fila de rotulagem está pronta
   e vazia.
4. **As fixtures são sintéticas.** O acervo real tem 311 memórias técnicas,
   muito mais parecidas entre si (cosseno médio 0,307).
5. **A calibração de ponteiro foi escolhida no dev**, mas o desenho das regras
   foi influenciado por diagnóstico no eval — o bloqueado é a única proteção.
6. **Empacotamento, download em produção e máquinas fracas não foram testados.**

### 13.8 Arquivos desta etapa

| arquivo | o que é |
|---|---|
| `electron/lib/memory/bench/policy.ts` | políticas P1/P2/P3 e o critério pré-registrado |
| `electron/lib/memory/bench/audit.test.ts` | runner de validação (matriz, forense, bloqueado, ablações) |
| `electron/lib/memory/bench/support.ts` | carga de fixture e modelo |
| `electron/lib/memory/bench/blocked.json` | conjunto bloqueado (16 memórias, 38 casos) |
| `electron/lib/memory/bench/real.test.ts` | acervo real: quase-duplicados e fila de rotulagem |
| `electron/lib/memory/embedding.test.ts` | +2 testes (edição e enriquecimento invalidam o vetor) |
| `electron/lib/memory/service.ts` | `AUTO_CONTEXT_ENABLED` (desligado por padrão) |
| `electron/lib/memory/bench/harness.ts` | split `blocked` |

### 13.9 Reprodução

```bash
cd apps/desktop

# 1. Benchmark de ajuste (calibra no dev; NÃO valida)
MEMORY_BENCH=1 npx vitest run electron/lib/memory/bench/eval.test.ts

# 2. Validação (aplica as políticas pré-registradas; não calibra)
MEMORY_AUDIT=1 npx vitest run electron/lib/memory/bench/audit.test.ts

# 3. Acervo real (lê os itens locais; não imprime conteúdo; gera a fila de revisão)
MEMORY_BENCH_REAL=1 npx vitest run electron/lib/memory/bench/real.test.ts

# 4. Suíte e tipos
npx tsc --noEmit && npx vitest run
```

Resultados completos em `apps/desktop/.cache/memory-embed/results/` (`audit-a8m.json`,
`audit-a25m.json`).

## 14. Piloto de validação com as memórias reais (24/10/2026)

A calibração anterior usou fixtures sintéticas. Esta etapa troca a pergunta: com as
**311 memórias reais**, a recuperação acha o que importa? Os rótulos são humanos e
produzidos **localmente** — nenhum texto de memória sai da máquina.

### Fluxo

```bash
cd apps/desktop

# 1. sorteia o lote (50) e a amostra piloto (20) — determinístico, semente fixa
MEMORY_REVIEW=build npx vitest run electron/lib/memory/bench/review.test.ts

# 2. abre a página local e rotula
open ~/.orbit-memory-review/revisar.html
#    → preencha a consulta, o contexto (se houver), a decisão esperada e o motivo
#    → "Exportar rótulos" gera rotulos.json; salve em ~/.orbit-memory-review/

# 3. avalia lexical (o que memory_search faz hoje) × híbrido
MEMORY_REVIEW=eval npx vitest run electron/lib/memory/bench/review.test.ts
#    para o outro modelo:
MEMORY_REVIEW_MODEL=a25m MEMORY_REVIEW=eval npx vitest run electron/lib/memory/bench/review.test.ts
```

### O que a página faz

- Cada cenário traz **uma memória-âncora** e o papel dela: `memória-alvo` (deveria ser
  recuperada) ou `tema relacionado — NÃO deve recuperar` (negativo difícil).
- Campos: consulta, contexto recente, decisão esperada (conteúdo completo / ponteiro /
  nenhuma / **inconclusivo**) e motivo curto.
- Autosave em `localStorage`, filtro piloto/todos, importação de um `rotulos.json`
  anterior e exportação. Atalhos: `⌘↵` avança, `⌘⇧I` marca inconclusivo.
- Tudo em `~/.orbit-memory-review/` — **fora do repositório**. Não versione.

### O que o avaliador mede

`lexical` usa `searchMemories` (a busca que `memory_search` usa hoje). `híbrido` usa
embeddings + BM25 + RRF, a mesma configuração do benchmark. Para cada cenário rotulado:
posição da memória-alvo nos dois rankings, R@1/R@5/MRR, quem acha o que o outro perde, e
para os negativos quantos devolveram candidato. A decisão da política (P1) é registrada
como **hipótese** — a injeção automática continua desligada.

A divisão dev/avaliação é por **grupo de memória** (hash do id), para paráfrases da mesma
memória nunca caírem em lados opostos. Com 20 casos ela é **diagnóstica**, não
confirmatória.

### Composição do piloto (20)

5 negativos difíceis (tema relacionado), 15 com memória-alvo, 4 em inglês (cruzados).
O acervo real é 284 pt / 16 en / 11 sem marcador claro — a amostra cruzada **não** serve
como validação multilíngue.

Achado de composição: o acervo real é dominado por `decision` (100), `learning` (81),
`structure` (71) e `convention` (20); `preference` tem só 7. A fixture sintética, ao
contrário, era rica em preferências pessoais — a recalibração feita nela pode não
transferir para este perfil.
