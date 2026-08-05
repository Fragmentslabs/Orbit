import type { ModelScores, PriceTier, SpeedTier } from "@shared/models"

/** Labels e formatters da aba Models (separados dos componentes p/ fast refresh). */

export const CAPABILITY_LABELS: Record<string, string> = {
  coding: "Coding",
  vision: "Vision",
  agent: "Agent",
  reasoning: "Reasoning",
}

/** Modalidades de entrada (models.dev/OpenRouter): text, image, audio, video, pdf */
export const MODALITY_LABELS: Record<string, string> = {
  text: "Text",
  image: "Image",
  audio: "Audio",
  video: "Video",
  pdf: "Document (PDF)",
}

export const PRICE_LABELS: Record<PriceTier, string> = {
  free: "Free",
  low: "Low Cost",
  medium: "Medium",
  premium: "Premium",
}

export const SPEED_LABELS: Record<SpeedTier, string> = {
  fast: "Fast",
  balanced: "Balanced",
  deep: "Deep Thinking",
}

/** Nomes amigáveis para ids de disponibilidade (models.dev + openrouter) */
export const AVAILABILITY_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  opencode: "OpenCode",
  "google-vertex": "Vertex AI",
  "amazon-bedrock": "Bedrock",
  azure: "Azure",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
}

export function availabilityLabel(id: string): string {
  return AVAILABILITY_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

export function formatContext(tokens: number): string {
  if (!tokens) return "—"
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  return `${Math.round(tokens / 1000)}k`
}

/** USD por 1M de tokens */
export function formatPrice(value: number): string {
  if (value <= 0) return "Free"
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function scoreColor(score: number): string {
  if (score >= 80) return "bg-emerald-500"
  if (score >= 55) return "bg-amber-500"
  return "bg-rose-500"
}

/** Categorias exibidas em comparação/detalhe, na ordem do spec. */
export const SCORE_CATEGORIES: { key: keyof ModelScores; label: string }[] = [
  { key: "coding", label: "Coding" },
  { key: "agentic", label: "Agentic" },
  { key: "vision", label: "Vision" },
  { key: "speed", label: "Speed" },
  { key: "intelligence", label: "Intelligence" },
]
