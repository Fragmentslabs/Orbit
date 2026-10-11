# Voz (STT/TTS)

Feature de fala local do Orbit: **ditado (STT)** e **leitura em voz alta (TTS)**,
tudo processado na própria máquina. Nada de áudio sai para nuvem por causa desta
feature.

## O que é

- **TTS — Supertonic 3 (Supertone).** Síntese de voz local via ONNX Runtime (CPU),
  10 vozes pré-treinadas (`M1–M5`, `F1–F5`), multilíngues (31 idiomas, `pt`
  incluído). Suporta **streaming por pedaço de texto**: a síntese é cortada por
  frase e cada pedaço é emitido assim que fica pronto, de modo que o som começa
  antes de a síntese inteira terminar. Áudio servido a 24 kHz, mono, 16-bit.
- **STT — Parakeet / whisper.** Duas famílias de reconhecimento:
  - **NVIDIA Parakeet TDT 0.6B v3** (via sherpa-onnx, só CPU): cobre 25 línguas
    europeias (inclui `pt`) e detecta o idioma sozinho. É o candidato para
    Windows/Linux. A interface `sherpa-onnx-node` é N-API (ABI estável), então
    roda no Electron sem recompilar.
  - **whisper.cpp** (modelos OpenAI Whisper convertidos para ggml; binding
    `smart-whisper`): múltiplos tamanhos, de `tiny` a `large-v3-turbo`.

Os modelos **não fazem parte do build nem da distribuição do app**. Eles são
baixados **sob demanda, a pedido do usuário**, e ficam em disco local.

## Onde ficam os arquivos no repo

| Caminho | Papel |
|---|---|
| `apps/desktop/electron/lib/voice/` | Módulo de voz do processo principal do Electron |
| `apps/desktop/electron/lib/voice/manifest.ts` | Manifesto/catálogo dos modelos oferecidos e seus metadados |
| `apps/desktop/electron/lib/voice/stt.ts` | Motor de STT (Parakeet/whisper) |

> Observação: no momento em que este documento foi escrito, o diretório
> `apps/desktop/electron/lib/voice/` e seus arquivos ainda **não existem** neste
> worktree — a lista de modelos abaixo vem do laboratório de decisão em
> `/Users/desknik/Projects/Testes` (vozlab + supertonic-tts). Se a implementação
> real trouxer uma lista diferente, o `manifest.ts` é a fonte da verdade e este
> documento deve ser alinhado a ele.

## Modelos baixados, de onde e com quais licenças

### TTS — Supertonic 3 (pesos)

- **Origem:** Hugging Face `supertone-oss-archive/supertonic-3`
  (<https://huggingface.co/supertone-oss-archive/supertonic-3>).
- **Licença dos pesos:** **OpenRAIL-M** (texto com restrições de uso em
  <https://huggingface.co/supertone-oss-archive/supertonic-3/blob/main/LICENSE>).
- **Licença do SDK/helper:** MIT (Supertone Inc.).
- Os pesos são **baixados sob demanda pelo usuário** e **não fazem parte do
  build/distribuição** do app.

### STT — whisper.cpp (modelos ggml)

- **Origem:** Hugging Face `ggerganov/whisper.cpp`, baixados para uma pasta de
  modelos local (`https://huggingface.co/ggerganov/whisper.cpp`).
- **Licença:** OpenAI Whisper (modelo original) é MIT; whisper.cpp/ggml é MIT.
- **Modelos oferecidos:** `tiny`, `base`, `small`, `medium` (`ggml-medium-q5_0`),
  `large-v3-turbo` (`ggml-large-v3-turbo-q5_0`) — e, no laboratório, também
  `large-v3-turbo-f16` e `distil-large-v3.5` (este só-inglês, vindo de
  `distil-whisper/distil-large-v3.5-ggml`).
- **Binding:** `smart-whisper` (MIT).

### STT — Parakeet TDT 0.6B v3

- **Origem:** distribuído pela sherpa-onnx como
  `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, baixado on demand dos releases
  `https://github.com/k2-fsa/sherpa-onnx/releases` (junto com o Silero VAD).
- **Licença do modelo:** **CC-BY-4.0** — modelo upstream NVIDIA
  (<https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>).
- **Licença do runtime:** sherpa-onnx é Apache-2.0.
- **ONNX Runtime** (`onnxruntime` / `onnxruntime-node`): MIT.

Os textos completos de licença e os avisos de atribuição estão no arquivo
[`NOTICE`](../NOTICE), na seção "Third-party notices — voice (STT/TTS)".

## Como habilitar / desabilitar

- **Desabilitado por padrão:** nenhum modelo é baixado nem executado sem uma ação
  explícita do usuário. O download de cada modelo (Supertonic 3, Parakeet,
  modelos do whisper) é iniciado **sob demanda** e pode ser removido do disco
  depois, sem afetar o restante do app.
- **Habilitar:** acionar a feature de voz nas configurações do app e escolher o
  motor/modelo; o download do modelo correspondente é disparado aí. Para o
  Supertonic 3 (TTS) e o Parakeet (STT), o primeiro uso baixa os pesos; depois
  tudo roda 100 % offline.
- **Desabilitar:** desligar a feature nas configurações e/ou apagar os arquivos de
  modelo baixados, liberando o espaço em disco. Como os pesos não fazem parte da
  distribuição, desligar a feature apenas interrompe o uso, não exige reinstalar o
  app.

> Detalhes de implementação (mensagens exatas, toggles e nomes de opções) devem
> ser confirmados no módulo `apps/desktop/electron/lib/voice/` quando ele existir
> neste worktree.
