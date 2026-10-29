import { runMemoryRoutine } from './routine'
import { cleanup, scheduleIndexSync } from './service'

/**
 * Cron de manutenção da memória: expiração + promoção automática + índice de
 * embeddings + rotina (captura diária / consolidação semanal).
 * Roda a cada 6 horas enquanto o app estiver aberto.
 *
 * A indexação entra aqui (e não no caminho da primeira pergunta) de propósito:
 * reindexar 300 memórias leva alguns segundos e não pode atrasar a conversa.
 * `scheduleIndexSync` tem debounce e roda em segundo plano; se o modelo não
 * estiver instalado, a sincronização falha em silêncio e o app segue no lexical.
 */

const INTERVAL = 6 * 60 * 60 * 1000
/**
 * A primeira passada espera as configurações. O scheduler sobe junto com a
 * janela, antes de `loadAppSettings` — rodar a rotina neste ponto leria o
 * padrão ("desligada") e a primeira captura só aconteceria 6 horas depois.
 */
const FIRST_RUN_DELAY = 60 * 1000

export function setupMemoryScheduler(): void {
  const run = () => {
    void cleanup().catch((err) => console.error('[memory] cleanup falhou:', err))
    // Cada fase da rotina se autolimita pela preferência e pela janela: o tick
    // de 6h só dá a carona.
    void runMemoryRoutine().catch((err) => console.error('[memory] rotina falhou:', err))
    scheduleIndexSync(500)
  }
  setTimeout(run, FIRST_RUN_DELAY).unref?.()
  setInterval(run, INTERVAL).unref?.()
}
