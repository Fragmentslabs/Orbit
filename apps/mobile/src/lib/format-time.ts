/**
 * Time in the locale standard: pt-BR uses 24h ("14:00") and English uses 12h ("2:00 PM").
 * `hour12` is forced explicitly so as not to depend on the ICU of the runtime.
 */
export function formatTime(ts: number, locale: string): string {
  const hour12 = !locale.toLowerCase().startsWith('pt')
  return new Date(ts).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  })
}

/** Full date + time in the locale standard (pt-BR: "quinta-feira, 6 de agosto de 2026 às 14:00"). */
export function formatDateTime(ts: number, locale: string): string {
  const date = new Date(ts).toLocaleDateString(locale, { dateStyle: 'full' })
  const time = formatTime(ts, locale)
  const connector = locale.toLowerCase().startsWith('pt') ? 'às' : 'at'
  return `${date} ${connector} ${time}`
}

/** Long date + time (pt-BR: "6 de agosto de 2026 às 14:00") — used in the routines. */
export function formatDateTimeShort(ts: number, locale: string): string {
  const date = new Date(ts).toLocaleDateString(locale, { dateStyle: 'long' })
  const time = formatTime(ts, locale)
  const connector = locale.toLowerCase().startsWith('pt') ? 'às' : 'at'
  return `${date} ${connector} ${time}`
}
