/**
 * PRE-REGISTERED policies for the final validation.
 *
 * The choice of policy was made on the `dev` split (family F, ceiling of 2 false
 * positives). These constants exist so the blocked set is
 * evaluated ONCE, against rules defined beforehand — and not to tune a threshold
 * after seeing the result.
 *
 * Safety ladder (the decision is taken in this order, with no going back):
 *
 *   P1 — calibrated injection (family F). It is only approved if the precision per
 *        injected memory on the blocked set is >= 98% AND the lower
 *        bound of the 95% CI of that precision is >= 90%.
 *   P2 — pointers only: automatic injection off. The safety net when
 *        the evidence does not support injection.
 *   P3 — strict injection: the highest threshold that still injects on dev with ZERO
 *        false positives. Used if P1 fails and P3 passes the criterion.
 *
 * If none passes, the default is P2 — never relax the threshold to gain recall.
 */
import {
  PRODUCTION_RETRIEVAL,
  DEFAULT_SELECTION,
  type RetrievalParams,
  type SelectionParams,
} from '@shared/memory-select'

/** Precision target for automatic injection, defined BEFORE looking at the blocked set. */
export const INJECTION_PRECISION_TARGET = 0.98
/** Lower bound of the 95% CI (Wilson) required along with the target. */
export const INJECTION_PRECISION_CI_FLOOR = 0.9

export interface Policy {
  id: 'P1' | 'P2' | 'P3'
  name: string
  retrieval: RetrievalParams
  selection: SelectionParams
  /** Uses the pool's noise floor as the base for the relative thresholds. */
  useNoise: boolean
}

/**
 * Fusion calibrated on dev: small lexical weight + coverage cut. At equal
 * weight RRF loses ~30 pp of R@1 (measured); with the cut, it ties with the
 * semantic one and keeps the exact identifier.
 *
 * The definition lives in `@shared/memory-select`: the production search uses the SAME
 * constant, and duplicating it here would leave the benchmark measuring something else.
 */
export { PRODUCTION_RETRIEVAL }

/**
 * Winning parameters of the calibration on `dev` (family F, Bekko a8m).
 * `useNoise: false` → the effective thresholds are absolute: 0.60 and 0.50.
 */
export const P1_SELECTION: SelectionParams = {
  ...DEFAULT_SELECTION,
  threshold: 'collection',
  injectCos: 0.6,
  pointerCos: 0.5,
  injectDelta: 0.22,
  pointerDelta: 0,
  lexInjectCoverage: 0.7,
  lexPointerCoverage: 2,
  maxInject: 3,
  maxPointers: 2,
  gap: 0.1,
  maxInjectChars: 600,
}

export const P1: Policy = {
  id: 'P1',
  name: 'calibrated injection (family F)',
  retrieval: PRODUCTION_RETRIEVAL,
  selection: P1_SELECTION,
  useNoise: false,
}

/** Pointers only: no automatic injection (impossible injectCos). */
export const P2: Policy = {
  id: 'P2',
  name: 'pointers only (injection off)',
  retrieval: PRODUCTION_RETRIEVAL,
  selection: { ...P1_SELECTION, injectCos: 2, lexInjectCoverage: 2 },
  useNoise: false,
}

/**
 * Strict injection. The threshold is not picked by hand: `strictInjectCos()` finds,
 * on dev, the highest threshold that still injects something with zero FP.
 */
export function P3(injectCos: number): Policy {
  return {
    id: 'P3',
    name: `strict injection (cosine >= ${injectCos.toFixed(2)}, 0 FP on dev)`,
    retrieval: PRODUCTION_RETRIEVAL,
    selection: { ...P1_SELECTION, injectCos },
    useNoise: false,
  }
}
