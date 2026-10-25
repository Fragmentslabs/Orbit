/**
 * Núcleo de voz (texto→fala e fala→texto) rodando LOCAL, no processo main.
 *
 * Dois motores independentes, com uma regra em comum: o PESO do modelo nunca
 * entra no build. O app baixa sob demanda para `<userData>/voice/models/<id>` e,
 * depois disso, funciona 100 % offline — a única rede que existe é o download.
 *
 *  - TTS: Supertonic 3 (ONNX Runtime, CPU). Voz padrão F2, idioma pt.
 *  - STT: Parakeet TDT 0.6B v3 (sherpa-onnx) ou whisper.cpp — a escolha por
 *    máquina sai de `VoiceHardwareInfo` (ver hardware.ts no main).
 *
 * `VoiceEngineId` cobre só os motores de STT de propósito: o TTS é um só
 * ("supertonic") e não é escolhido por hardware.
 */

/** Motor de transcrição (fala→texto) disponível na máquina. */
export type VoiceEngineId = "parakeet" | "whisper"

/**
 * Onde a fala é SINTETIZADA.
 *
 *  - `model`: pela rota do MODELO (provedor de IA) quando existe uma — é o
 *    padrão. Sem provedor configurado, ou com a rota falhando, o pipeline cai
 *    no motor local: a preferência nunca deixa a leitura muda.
 *  - `local`: sempre pelo motor local (Supertonic 3), 100 % offline.
 */
export type VoiceTtsEngine = "model" | "local"

/** Natureza do modelo: sintetiza fala (tts) ou transcreve áudio (stt). */
export type VoiceModelKind = "tts" | "stt"

/**
 * As duas funções de voz, que ligam e desligam separadamente nas Preferências.
 * Desligada, a ferramenta nem é registrada no turno.
 */
export type VoiceFeature = VoiceModelKind

/**
 * Um modelo baixável (arquivo único de STT, ou o pacote de arquivos do TTS).
 * `bytes` é o total que o download ocupa em disco, não o tamanho de um arquivo
 * específico — é o número que a UI mostra antes de o usuário decidir baixar.
 */
export interface VoiceModelInfo {
  /** id estável; é também o nome da pasta em `<userData>/voice/models/<id>`. */
  id: string
  kind: VoiceModelKind
  /** Motor que consome o modelo ("supertonic", "parakeet", "whisper"). */
  engine: string
  /** Rótulo para a UI, com o que o modelo faz e quanto pesa. */
  label: string
  /** Tamanho total do download, em bytes. */
  bytes: number
  /** Origem dos arquivos (o arquivo, ou a página do modelo quando é um pacote). */
  url: string
  /** sha256 do arquivo, quando a origem publica um por modelo. */
  sha256?: string
  /** Idiomas cobertos (códigos ISO/BCP-47 curtos), quando o modelo limita. */
  langs?: string[]
  /**
   * O modelo vem em PACOTE (ex.: o `.tar.bz2` do Parakeet) e precisa ser
   * EXTRAÍDO antes de o motor usar. Um pacote baixado ainda não é "pronto".
   */
  archive?: boolean
}

/** Progresso de um download em curso (evento `voice:download-progress`). */
export interface VoiceDownloadProgress {
  modelId: string
  /** Bytes já no disco (soma dos arquivos do modelo). */
  received: number
  /** Bytes totais do modelo — 0 até a origem informar o content-length. */
  total: number
  done: boolean
  /** Preenchido quando terminou com erro (rede, disco, integridade). */
  error?: string
}

/**
 * O que a máquina é capaz de rodar — o `voice:hardware` devolve isto para a UI
 * poder explicar a escolha em vez de só mostrá-la. `reason` e `warnings` vêm
 * SEMPRE preenchidos: a recomendação sem justificativa vira caixa-preta.
 */
export interface VoiceHardwareInfo {
  platform: string
  arch: string
  /** RAM total da máquina, em GB (GiB arredondado para 0,1). */
  totalMemGb: number
  cpus: number
  recommendedEngine: VoiceEngineId
  /** id de um modelo do catálogo (`voice:models`) — não uma string livre. */
  recommendedModel: string
  /** Por que este motor/modelo, nesta máquina, em uma frase. */
  reason: string
  /** O que pode dar errado mesmo assim (memória baixa, modelo não baixado...). */
  warnings: string[]
}

/** Disponibilidade de um motor de transcrição (sem tocar em modelo nenhum). */
export interface VoiceEngineStatus {
  engine: VoiceEngineId
  /** O artefato do motor está no disco (o modelo escolhido foi baixado). */
  installed: boolean
  /**
   * Os BYTES do modelo estão no disco — o que o downloader sabe, sem opinar se o
   * motor já consegue usar (o pacote do Parakeet fica assim antes de extrair).
   * É o que evita o selo dizer "não baixado" ao lado de um texto dizendo que
   * baixou; quem responde "dá para usar?" é `installed`/`available`.
   */
  downloaded?: boolean
  /** Dá para rodar JÁ nesta máquina (binário existe/compila, arch suportada). */
  available: boolean
  /** Motivo, sempre que `available` for false (ou quando vale avisar algo). */
  reason?: string
  /**
   * O modelo que o motor usa com o "Automático" (`modelId` nulo) — quem decide
   * é o motor, então a tela mostra o "Em uso" daqui em vez de adivinhar.
   */
  autoModelId?: string
}

/**
 * Estado fino de um modelo no disco. É a fonte ÚNICA do selo ("installed") e do
 * texto do motivo: os dois saem deste mesmo retrato, então não podem discordar.
 *
 *   absent      nada no disco
 *   partial     download interrompido/cancelado (há bytes, não o modelo inteiro)
 *   downloading download em curso
 *   downloaded  bytes completos e conferidos, mas o motor AINDA não consegue usar
 *               (é o caso do pacote que falta extrair)
 *   extracting  extração do pacote em curso
 *   ready       o motor consegue usar AGORA (equivale a `installed`)
 *   error       a última operação falhou (download ou extração)
 */
export type VoiceModelState =
  | "absent"
  | "partial"
  | "downloading"
  | "downloaded"
  | "extracting"
  | "ready"
  | "error"

/** Retrato de UM modelo do catálogo — a resposta honesta de "dá para usar?". */
export interface VoiceModelStatus {
  /**
   * Os bytes estão no disco e conferidos (tamanho EXATO de cada arquivo; o
   * sha256 é conferido no fim do download). Não significa que dá para usar: um
   * pacote fica `downloaded` e ainda precisa de extração.
   */
  downloaded: boolean
  /**
   * O MOTOR consegue usar o modelo agora. Para o Parakeet isto é o pacote
   * EXTRAÍDO com o VAD Silero presente; para o TTS e os modelos de whisper é o
   * arquivo completo. O selo da UI e o texto do motivo devem sair daqui
   * (`installed` + `state` + `reason`), nunca do estado do downloader.
   */
  installed: boolean
  /**
   * Mesmo que `installed`, com o nome explícito que o renderer já esperava
   * (`downloaded` para "os bytes chegaram", `ready` para "dá para usar").
   */
  ready: boolean
  /** Estado fino; `ready` é o único estado em que `installed` é true. */
  state: VoiceModelState
  /** Bytes já no disco (inclui o `.part` de um download retomável). */
  received: number
  /** Bytes totais esperados (`VoiceModelInfo.bytes`). */
  total: number
  /** Por que NÃO está utilizável agora, quando `installed` é false. */
  reason?: string
  /** A falha concreta quando `state === "error"`. */
  error?: string
}

/** Retrato do núcleo de voz para a tela de configurações. */
export interface VoiceStatusSnapshot {
  /** Estado por id do catálogo (TTS e STT) — mesma fonte para selo e motivo. */
  models: Record<string, VoiceModelStatus>
  engines: VoiceEngineStatus[]
  /** O motor de TTS está REALMENTE utilizável: modelo presente/válido + motor no build. */
  ttsReady: boolean
  /**
   * Rota de fala PELO MODELO (provedor de IA). É a metade da prioridade de
   * áudio que não depende do disco: sem provedor configurado com fala, a
   * preferência "modelo" cai no motor local e a UI diz por quê.
   */
  modelTts?: VoiceModelTtsStatus
}

/** Disponibilidade da síntese de fala pelo provedor de IA (preferência "Modelo de voz"). */
export interface VoiceModelTtsStatus {
  /** Há uma rota de fala utilizável agora (provedor configurado + modelo de fala). */
  available: boolean
  /** Provedor e modelo que a rota usaria, quando disponível. */
  providerId?: string
  modelId?: string
  /** Motivo de estar indisponível — a fala então sai pelo motor local. */
  reason?: string
}

/** Preferências do TTS (texto→fala). */
export interface VoiceTtsSettings {
  enabled: boolean
  /** Voz do Supertonic: M1–M5 (masculinas) ou F1–F5 (femininas). */
  voice: string
  /** Código do idioma (`pt`, `en`, …) ou `na` (agnóstico). */
  lang: string
  /** Fator de velocidade, 0,5–2,0 (1 = natural). */
  speed: number
  /**
   * Prioridade do áudio: por onde a fala é sintetizada. `model` (padrão) tenta
   * a rota do provedor e, sem ela, usa o motor local; `local` força o motor
   * local. Ver `VoiceTtsEngine`.
   */
  engine: VoiceTtsEngine
}

/** Preferências do STT (fala→texto). */
export interface VoiceSttSettings {
  enabled: boolean
  engine: VoiceEngineId
  /** id do modelo de STT escolhido; null = usar o recomendado pelo hardware. */
  modelId: string | null
  /** Idioma da fala (`pt`, `en`, …) ou `auto` quando o motor detecta sozinho. */
  language: string
  /** Texto ao vivo enquanto a pessoa fala (o motor decide como publicar). */
  live: boolean
  /** Threads de inferência (3–4 é o ponto doce medido; ver vozlab §18). */
  threads: number
  /**
   * Pré-carrega o modelo de ditado: RAM em troca de ditado instantâneo.
   *
   * Ligado (padrão), o motor aquece assim que o download termina e quando o
   * microfone aparece, e solta o modelo depois de um tempo ocioso. Desligado,
   * só o primeiro ditado paga o carregamento — e ele fica esperando.
   */
  preload: boolean
  /**
   * Microfone da captura (`deviceId` do `enumerateDevices`); null = o padrão do
   * sistema. Vale para o ditado e para o modo chamada (os dois abrem o
   * microfone pelo mesmo hook). Um aparelho que sumiu cai no padrão.
   */
  micDeviceId: string | null
}

/** Opções do silêncio que encerra a fala no modo chamada (ms). */
export const VOICE_CALL_SILENCE_OPTIONS = [900, 1300, 1800, 2500] as const

/**
 * Modo chamada: conversa por voz em tempo real — o ditado ouve (com prévia ao
 * vivo), a fala lê a resposta enquanto ela chega, e o agente responde curto.
 */
export interface VoiceCallSettings {
  /** Mostra o botão de chamada ao lado do microfone. */
  enabled: boolean
  /** Silêncio (ms) depois da fala que encerra a sua vez e envia a mensagem. */
  silenceMs: number
}

export interface VoiceSettings {
  tts: VoiceTtsSettings
  stt: VoiceSttSettings
  call: VoiceCallSettings
}

/**
 * Padrões do núcleo de voz: fala em pt-BR desde o primeiro clique, com a
 * prioridade de áudio no MODELO (cai no motor local quando não há rota).
 */
export const VOICE_DEFAULTS: VoiceSettings = {
  tts: { enabled: true, voice: "F2", lang: "auto", speed: 1, engine: "model" },
  stt: { enabled: true, engine: "parakeet", modelId: null, language: "auto", live: true, threads: 4, preload: true, micDeviceId: null },
  call: { enabled: true, silenceMs: 1300 },
}
