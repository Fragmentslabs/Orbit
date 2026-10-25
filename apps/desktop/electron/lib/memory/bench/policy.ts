/**
 * Políticas PRÉ-REGISTRADAS para a validação final.
 *
 * A escolha da política foi feita no split `dev` (família F, teto de 2 falsos
 * positivos). Estas constantes existem para que o conjunto bloqueado seja
 * avaliado UMA vez, contra regras definidas antes — e não para ajustar limiar
 * depois de ver o resultado.
 *
 * Escada de segurança (a decisão é tomada nesta ordem, sem voltar atrás):
 *
 *   P1 — injeção calibrada (família F). Só é aprovada se a precisão por
 *        memória injetada no conjunto bloqueado for >= 98% E o limite
 *        inferior do IC95 dessa precisão for >= 90%.
 *   P2 — só ponteiros: injeção automática desligada. Rede de segurança quando
 *        a evidência não sustenta injeção.
 *   P3 — injeção estrita: maior limiar que ainda injeta no dev com ZERO
 *        falsos positivos. Usada se P1 reprovar e P3 passar no critério.
 *
 * Se nenhuma passar, o padrão é P2 — nunca relaxar o limiar para ganhar recall.
 */
import {
  PRODUCTION_RETRIEVAL,
  DEFAULT_SELECTION,
  type RetrievalParams,
  type SelectionParams,
} from '@shared/memory-select'

/** Meta de precisão da injeção automática, definida ANTES de ver o bloqueado. */
export const INJECTION_PRECISION_TARGET = 0.98
/** Piso do IC95 (Wilson) exigido junto da meta. */
export const INJECTION_PRECISION_CI_FLOOR = 0.9

export interface Policy {
  id: 'P1' | 'P2' | 'P3'
  name: string
  retrieval: RetrievalParams
  selection: SelectionParams
  /** Usa o piso de ruído do acervo como base dos limiares relativos. */
  useNoise: boolean
}

/**
 * Fusão calibrada no dev: peso lexical pequeno + corte de cobertura. Com peso
 * igual o RRF perde ~30 pp de R@1 (medido); com o corte, empata com o
 * semântico e mantém o identificador exato.
 *
 * A definição mora em `@shared/memory-select`: a busca de produção usa a MESMA
 * constante, e duplicá-la aqui deixaria o benchmark medindo outra coisa.
 */
export { PRODUCTION_RETRIEVAL }

/**
 * Parâmetros vencedores da calibração em `dev` (família F, Bekko a8m).
 * `useNoise: false` → os limiares efetivos são absolutos: 0,60 e 0,50.
 */
export const P1_SELECTION: SelectionParams = {
  ...DEFAULT_SELECTION,
  threshold: 'acervo',
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
  name: 'injeção calibrada (família F)',
  retrieval: PRODUCTION_RETRIEVAL,
  selection: P1_SELECTION,
  useNoise: false,
}

/** Só ponteiros: nenhuma injeção automática (injectCos impossível). */
export const P2: Policy = {
  id: 'P2',
  name: 'somente ponteiros (injeção desligada)',
  retrieval: PRODUCTION_RETRIEVAL,
  selection: { ...P1_SELECTION, injectCos: 2, lexInjectCoverage: 2 },
  useNoise: false,
}

/**
 * Injeção estrita. O limiar não é escolhido a dedo: `strictInjectCos()` acha,
 * no dev, o maior limiar que ainda injeta alguma coisa com zero FP.
 */
export function P3(injectCos: number): Policy {
  return {
    id: 'P3',
    name: `injeção estrita (cosseno >= ${injectCos.toFixed(2)}, 0 FP no dev)`,
    retrieval: PRODUCTION_RETRIEVAL,
    selection: { ...P1_SELECTION, injectCos },
    useNoise: false,
  }
}
