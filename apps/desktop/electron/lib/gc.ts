import v8 from 'node:v8'
import vm from 'node:vm'

/**
 * Coleta de lixo forçada no main — para quando um addon NATIVO acabou de ser
 * solto.
 *
 * O caso que motivou: o recognizer do Parakeet (sherpa-onnx) segura ~700 MB de
 * memória nativa atrás de um objeto JS minúsculo. Soltar a referência não
 * devolve nada: para o V8 aquele objeto não pesa, então o GC não tem pressa de
 * coletá-lo, e o finalizador que libera o ONNX Runtime não roda. Medido no
 * Electron: 825 MB com o modelo, 825 MB depois de soltar, 151 MB depois de uma
 * coleta forçada.
 *
 * O `gc()` só existe com `--expose-gc`; ligar a flag em runtime e pegar a
 * função num contexto novo é o caminho documentado pelo próprio V8 para isso.
 * Custa uma pausa de dezenas de ms — chame só depois de soltar algo grande,
 * nunca num caminho quente.
 */
let gcFn: (() => void) | null | undefined

export function collectGarbage(): void {
  if (gcFn === undefined) {
    try {
      v8.setFlagsFromString('--expose_gc')
      gcFn = vm.runInNewContext('gc') as () => void
    } catch {
      gcFn = null
    }
  }
  try {
    gcFn?.()
  } catch {
    // melhor-esforço: sem GC forçado, a memória volta quando o V8 quiser
  }
}

/**
 * Coleta logo e de novo um pouco depois: o finalizador do addon pode só ficar
 * pronto na segunda passada (o primeiro ciclo marca, o segundo libera).
 */
export function collectGarbageSoon(): void {
  collectGarbage()
  setTimeout(collectGarbage, 1500).unref?.()
}
