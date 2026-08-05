/** Formatação compartilhada de tokens e custo (badge de usage, card da orchestra). */

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatCost(cost: number): string {
  if (cost >= 0.01) return `$${cost.toFixed(2)}`
  return `$${cost.toFixed(4)}`
}

/**
 * Horário no padrão do locale: pt-BR usa 24h ("14:00") e inglês usa 12h ("2:00 PM").
 * O `hour12` é forçado explicitamente porque alguns runtimes (ICU reduzido) caem no
 * padrão en-US e mostrariam "02:00 PM" mesmo com o locale pt-BR.
 */
export function formatTime(ts: number, locale: string): string {
  const hour12 = !locale.toLowerCase().startsWith("pt")
  return new Date(ts).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12,
  })
}

/** Data completa + horário no padrão do locale (ex.: pt "quinta-feira, 6 de agosto de 2026 às 14:00"). */
export function formatDateTime(ts: number, locale: string): string {
  const date = new Date(ts).toLocaleDateString(locale, { dateStyle: "full" })
  const time = formatTime(ts, locale)
  const connector = locale.toLowerCase().startsWith("pt") ? "às" : "at"
  return `${date} ${connector} ${time}`
}

/** Duração legível (ex.: "3s", "1m 12s", "2h 05m") a partir de um intervalo em ms. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${String(minutes).padStart(2, "0")}m`
}
