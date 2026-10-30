/** Shared token and cost formatting (usage badge, orchestra card). */

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
 * Time in the locale's pattern: pt-BR uses 24h ("14:00") and English uses 12h ("2:00 PM").
 * `hour12` is forced explicitly because some runtimes (reduced ICU) fall back to the
 * en-US default and would show "02:00 PM" even with the pt-BR locale.
 */
export function formatTime(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: uses12h(locale),
  })
}

function uses12h(locale: string): boolean {
  return !locale.toLowerCase().startsWith("pt")
}

/**
 * Full date + time in the locale's pattern ("Thursday, August 6, 2026 at 2:00 PM").
 * Intl joins the two parts itself, with the connector each language uses — no
 * word of any language is written here.
 */
export function formatDateTime(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, { dateStyle: "full", timeStyle: "short", hour12: uses12h(locale) })
}

/** Date (day, month and year, without the weekday name) + time ("August 6, 2026 at 2:00 PM"). */
export function formatDateTimeShort(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, { dateStyle: "long", timeStyle: "short", hour12: uses12h(locale) })
}

/**
 * Date in numbers only + time ("08/27/2026, 02:30 PM"). The day/month order comes
 * from the locale itself — in English the month comes first. For where the
 * spelled-out month does not fit, like the commit card.
 */
export function formatDateTimeNumeric(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: uses12h(locale),
  })
}

/** Readable duration (e.g.: "3s", "1m 12s", "2h 05m") from an interval in ms. */
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
