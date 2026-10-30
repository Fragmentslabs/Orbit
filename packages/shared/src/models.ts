/**
 * Types of the Models tab — unified catalog built by the Orbit Ranking
 * Engine (electron/lib/models) from OpenRouter, Artificial Analysis
 * and the models.dev catalog (availability per provider).
 */

/** Scores normalized 0→100 (relative to the best model of the dataset). */
export interface ModelScores {
  intelligence?: number
  coding?: number
  agentic?: number
  vision?: number
  speed?: number
}

/** Raw technical values, shown in the "Technical" mode of the comparison. */
export interface ModelBenchmarks {
  /** Artificial Analysis indices (AA's own scale) */
  intelligenceIndex?: number
  codingIndex?: number
  agenticIndex?: number
  /** Individual benchmarks (0-1 or 0-100 depending on the source, already in %) */
  swebench?: number
  livecodebench?: number
  gpqa?: number
  hle?: number
  mmluPro?: number
  /** Measured speed (median of the last 72h, via AA) */
  tokensPerSecond?: number
  /** Time to first token, in seconds */
  ttft?: number
}

export type PriceTier = "free" | "low" | "medium" | "premium"
export type SpeedTier = "fast" | "balanced" | "deep"

export interface OrbitModel {
  /** Canonical slug (OpenRouter id when available, e.g. "anthropic/claude-opus-4.6") */
  id: string
  name: string
  /** Creator of the model (anthropic, openai, google…) */
  provider: string
  providerName: string
  contextWindow: number
  /** USD per 1M tokens */
  pricing: { input: number; output: number }
  priceTier: PriceTier
  speedTier: SpeedTier
  scores: ModelScores
  benchmarks: ModelBenchmarks
  /** Providers where the model is available (openrouter + models.dev ids) */
  availability: string[]
  /** Accepted input modalities (text, image, audio, video, pdf) — OpenRouter + models.dev union */
  modalities: string[]
  /** Derived capabilities: coding, vision, agent, reasoning, free… */
  tags: string[]
  releaseDate?: string
  /** Sources that contributed data */
  sources: ("openrouter" | "artificialanalysis")[]
}

export interface ModelsSnapshot {
  models: OrbitModel[]
  updatedAt: number
  /** Whether the Artificial Analysis key is configured (speed/benchmarks data) */
  hasAAKey: boolean
}
