import { cleanup, scheduleIndexSync } from './service'

/**
 * Cron de manutenção da memória: expiração + promoção automática + índice de
 * embeddings.
 * Roda no startup e a cada 6 horas enquanto o app estiver aberto.
 *
 * A indexação entra aqui (e não no caminho da primeira pergunta) de propósito:
 * reindexar 300 memórias leva alguns segundos e não pode atrasar a conversa.
 * `scheduleIndexSync` tem debounce e roda em segundo plano; se o modelo não
 * estiver instalado, a sincronização falha em silêncio e o app segue no lexical.
 */

const INTERVAL = 6 * 60 * 60 * 1000

export function setupMemoryScheduler(): void {
  const run = () => {
    void cleanup().catch((err) => console.error('[memory] cleanup falhou:', err))
    scheduleIndexSync(500)
  }
  setInterval(run, INTERVAL)
  run()
}
