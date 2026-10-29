/**
 * Re-export do avaliador de expressões dos blocos `orbit-ui`, que agora mora no
 * shared (o React Native avalia as mesmas fórmulas).
 *
 * A única diferença em relação ao shared é o locale: aqui, na tela do desktop,
 * ele sai do próprio documento — e é POR ISSO que a leitura do DOM ficou neste
 * arquivo. O módulo compartilhado não pode tocar `document`: ele também roda no
 * celular.
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
