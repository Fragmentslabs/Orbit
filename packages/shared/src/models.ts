/**
 * Tipos da aba Models — catálogo unificado construído pelo Orbit Ranking
 * Engine (electron/lib/models) a partir do OpenRouter, da Artificial Analysis
 * e do catálogo models.dev (disponibilidade por provedor).
 */

/** Scores normalizados 0→100 (relativos ao melhor modelo do dataset). */
export interface ModelScores {
  intelligence?: number
  coding?: number
  agentic?: number
  vision?: number
  speed?: number
}

/** Valores técnicos crus, exibidos no modo "Technical" da comparação. */
export interface ModelBenchmarks {
  /** Índices da Artificial Analysis (escala própria da AA) */
  intelligenceIndex?: number
  codingIndex?: number
  agenticIndex?: number
  /** Benchmarks individuais (0-1 ou 0-100 conforme a fonte, já em %) */
  swebench?: number
  livecodebench?: number
  gpqa?: number
  hle?: number
  mmluPro?: number
  /** Velocidade medida (mediana das últimas 72h, via AA) */
  tokensPerSecond?: number
  /** Time to first token, em segundos */
  ttft?: number
}

export type PriceTier = "free" | "low" | "medium" | "premium"
export type SpeedTier = "fast" | "balanced" | "deep"

export interface OrbitModel {
  /** Slug canônico (id do OpenRouter quando disponível, ex: "anthropic/claude-opus-4.6") */
  id: string
  name: string
  /** Criador do modelo (anthropic, openai, google…) */
  provider: string
  providerName: string
  contextWindow: number
  /** USD por 1M de tokens */
  pricing: { input: number; output: number }
  priceTier: PriceTier
  speedTier: SpeedTier
  scores: ModelScores
  benchmarks: ModelBenchmarks
  /** Provedores onde o modelo está disponível (openrouter + ids do models.dev) */
  availability: string[]
  /** Modalidades de entrada aceitas (text, image, audio, video, pdf) — union OpenRouter + models.dev */
  modalities: string[]
  /** Capacidades derivadas: coding, vision, agent, reasoning, free… */
  tags: string[]
  releaseDate?: string
  /** Fontes que contribuíram com dados */
  sources: ("openrouter" | "artificialanalysis")[]
}

export interface ModelsSnapshot {
  models: OrbitModel[]
  updatedAt: number
  /** Se a chave da Artificial Analysis está configurada (dados de speed/benchmarks) */
  hasAAKey: boolean
}
