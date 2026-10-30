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

/**
 * Full date + time in the locale standard ("Thursday, August 6, 2026 at 2:00 PM").
 * Intl joins the two parts with the connector each language uses.
 */
export function formatDateTime(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, {
    dateStyle: 'full',
    timeStyle: 'short',
    hour12: !locale.toLowerCase().startsWith('pt'),
  })
}

/** Long date + time ("August 6, 2026 at 2:00 PM") — used in the routines. */
export function formatDateTimeShort(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    hour12: !locale.toLowerCase().startsWith('pt'),
  })
}
