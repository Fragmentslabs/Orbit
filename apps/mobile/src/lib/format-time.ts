/**
 * Horário no padrão do locale: pt-BR usa 24h ("14:00") e inglês usa 12h ("2:00 PM").
 * O `hour12` é forçado explicitamente para não depender do ICU do runtime.
 */
export function formatTime(ts: number, locale: string): string {
  const hour12 = !locale.toLowerCase().startsWith('pt')
  return new Date(ts).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  })
}

/** Data completa + horário no padrão do locale (ex.: pt "quinta-feira, 6 de agosto de 2026 às 14:00"). */
export function formatDateTime(ts: number, locale: string): string {
  const date = new Date(ts).toLocaleDateString(locale, { dateStyle: 'full' })
  const time = formatTime(ts, locale)
  const connector = locale.toLowerCase().startsWith('pt') ? 'às' : 'at'
  return `${date} ${connector} ${time}`
}
