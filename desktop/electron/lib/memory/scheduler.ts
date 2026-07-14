import { cleanup } from './service'

/**
 * Cron de manutenção da memória: expiração + promoção automática.
 * Roda no startup e a cada 6 horas enquanto o app estiver aberto.
 */

const INTERVAL = 6 * 60 * 60 * 1000

export function setupMemoryScheduler(): void {
  const run = () => void cleanup().catch((err) => console.error('[memory] cleanup falhou:', err))
  setInterval(run, INTERVAL)
  run()
}
