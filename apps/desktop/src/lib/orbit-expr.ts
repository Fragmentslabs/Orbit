/**
 * Re-export of the `orbit-ui` blocks' expression evaluator, which now lives in
 * shared (React Native evaluates the same formulas).
 *
 * The only difference from shared is the locale: here, on the desktop screen,
 * it comes from the document itself — and that is WHY the DOM read stayed in this
 * file. The shared module cannot touch `document`: it also runs on the
 * phone.
 */
import { setDefaultLocale } from "@shared/orbit-expr"

export * from "@shared/orbit-expr"

if (typeof document !== "undefined") {
  setDefaultLocale(
    document.documentElement.lang ||
      (typeof navigator !== "undefined" ? navigator.language : "") ||
      undefined,
  )
}
