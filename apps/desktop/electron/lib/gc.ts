import v8 from 'node:v8'
import vm from 'node:vm'

/**
 * Forced garbage collection in the main — for when a NATIVE addon has just been
 * released.
 *
 * The case that motivated it: the Parakeet recognizer (sherpa-onnx) holds ~700 MB of
 * native memory behind a tiny JS object. Releasing the reference returns
 * nothing: for V8 that object does not weigh anything, so the GC is in no hurry to
 * collect it, and the finalizer that frees the ONNX Runtime does not run. Measured on
 * Electron: 825 MB with the model, 825 MB after releasing it, 151 MB after a
 * forced collection.
 *
 * `gc()` only exists with `--expose-gc`; enabling the flag at runtime and grabbing the
 * function in a new context is the path documented by V8 itself for that.
 * It costs a pause of tens of ms — call it only after releasing something big,
 * never on a hot path.
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
    // best-effort: without a forced GC, the memory comes back when V8 wants it
  }
}

/**
 * Collects right away and again a bit later: the addon's finalizer may only become
 * ready on the second pass (the first cycle marks, the second frees).
 */
export function collectGarbageSoon(): void {
  collectGarbage()
  setTimeout(collectGarbage, 1500).unref?.()
}
