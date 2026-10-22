import type { MediaKind } from "@shared/media"

/**
 * Catálogo do que o Orbit sabe fazer e que fica escondido atrás da conversa:
 * artefato clicável, documento, motion, edição de foto/vídeo, áudio gerado,
 * transcrição.
 *
 * É a fonte única de três lugares — as sugestões da tela inicial, o painel
 * "O que o Orbit faz?" e a frase que preenche o composer. Por isso aqui só há
 * DADOS: os textos moram no i18n (`chat.start.items.<id>.label` / `.desc` /
 * `.example` / `.howTo`) e o desenho mora nos componentes.
 */

export type CapabilityId =
  | "design"
  | "artifact"
  | "document"
  | "presentation"
  | "diagram"
  | "motion"
  | "vector"
  | "photo"
  | "video"
  | "record"
  | "docx"
  | "audio"
  | "transcript"
  | "voice"
  | "dictation"
  | "memory"
  | "routine"
  | "board"

export type CapabilityGroup = "create" | "media" | "work"

export type CapabilityMode = "chat" | "code"

/**
 * Metade da voz que uma capacidade precisa. O gate é o mesmo do engine: em
 * `tools/index.ts` a tool só é registrada quando a metade está ligada — não é
 * um filtro de interface, é o agente que não a enxerga.
 */
export type VoiceFeature = "tts" | "stt"

/**
 * Recurso que precisa estar ligado para a capacidade existir. A voz é o caso
 * que mais aparece (a tool nem é registrada), mas a gravação de vídeo depende
 * das ferramentas de navegador pelo mesmo motivo: sem elas não há
 * `browser_record` para executar o roteiro.
 */
export type CapabilityRequirement = VoiceFeature | "browser"

export interface Capability {
  id: CapabilityId
  group: CapabilityGroup
  /** Modos em que a capacidade é oferecida. */
  modes: readonly CapabilityMode[]
  /**
   * O que ela deixa na galeria. É a única coisa que a regra "priorizar o que
   * ele nunca produziu" consegue consultar: sem `produces`, a capacidade nunca
   * é marcada como nova — e por isso nunca é preterida.
   */
  produces?: MediaKind
  /**
   * A linha tem uma frase de exemplo que preenche o composer? As que não têm
   * (chamada de voz, ditado) se ativam no próprio input e aparecem no painel
   * com "onde fica", em vez do botão de experimentar.
   */
  hasExample: boolean
  /**
   * Recurso que precisa estar ligado para a capacidade existir de verdade.
   * Desligado, a tela não promete o que o agente não pode fazer: o painel
   * oferece o botão de ativar e as pills pulam a linha.
   */
  requires?: CapabilityRequirement
}

/**
 * Ordem de leitura do painel. A rotação da tela inicial parte daqui e gira,
 * então mexer nesta lista muda também quais capacidades aparecem no dia.
 */
export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = ["create", "media", "work"]

export const CAPABILITIES: readonly Capability[] = [
  // Criar
  { id: "design", group: "create", modes: ["chat", "code"], hasExample: true },
  { id: "artifact", group: "create", modes: ["chat", "code"], produces: "artifact", hasExample: true },
  { id: "document", group: "create", modes: ["chat", "code"], produces: "document", hasExample: true },
  { id: "presentation", group: "create", modes: ["chat", "code"], hasExample: true },
  { id: "diagram", group: "create", modes: ["chat", "code"], hasExample: true },
  { id: "motion", group: "create", modes: ["chat", "code"], produces: "motion", hasExample: true },
  { id: "vector", group: "create", modes: ["chat", "code"], hasExample: true },

  // Mídia
  { id: "photo", group: "media", modes: ["chat", "code"], produces: "image", hasExample: true },
  { id: "video", group: "media", modes: ["chat", "code"], produces: "video", hasExample: true },
  {
    id: "record",
    group: "media",
    modes: ["chat", "code"],
    produces: "video",
    hasExample: true,
    requires: "browser",
  },
  { id: "docx", group: "media", modes: ["chat", "code"], hasExample: true },
  { id: "audio", group: "media", modes: ["chat", "code"], produces: "audio", hasExample: true, requires: "tts" },
  { id: "transcript", group: "media", modes: ["chat", "code"], produces: "document", hasExample: true, requires: "stt" },
  { id: "voice", group: "media", modes: ["chat", "code"], hasExample: false },
  { id: "dictation", group: "media", modes: ["chat", "code"], hasExample: false },

  // Trabalho
  { id: "memory", group: "work", modes: ["chat", "code"], hasExample: true },
  { id: "routine", group: "work", modes: ["chat", "code"], hasExample: true },
  { id: "board", group: "work", modes: ["code"], hasExample: true },
]

export function capabilitiesOfGroup(group: CapabilityGroup): Capability[] {
  return CAPABILITIES.filter((capability) => capability.group === group)
}

export function capabilityById(id: CapabilityId): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.id === id)
}
