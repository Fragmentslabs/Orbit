import type { MediaCredit } from '@shared/media'

/**
 * Busca de imagens em fontes ABERTAS — Wikimedia Commons e Openverse. Nenhuma
 * pede chave, e as duas devolvem a licença e o autor de cada imagem, que é o que
 * deixa o agente usar a imagem numa peça com o crédito certo.
 */

export type ImageProvider = 'commons' | 'openverse'

/** O que o agente pede sobre a licença: `commercial` é o padrão (serve a um vídeo publicado). */
export type LicenseFilter = 'commercial' | 'public-domain' | 'any'

export type Orientation = 'landscape' | 'portrait' | 'square'

export interface ImageResult {
  /** Id curto que o agente usa para importar: `wc:123` (Commons) ou `ov:<uuid>` (Openverse). */
  id: string
  provider: ImageProvider
  title: string
  width?: number
  height?: number
  /** Miniatura para a olhada rápida. */
  thumbUrl: string
  /** Arquivo a baixar (já num tamanho razoável para vídeo). */
  downloadUrl: string
  /** Alternativa quando o endereço principal recusa (hotlink): a cópia que o provedor serve. */
  fallbackUrl?: string
  credit: MediaCredit
  /** De qual acervo o Openverse tirou (flickr, nasa…). */
  origin?: string
}

export interface SearchOptions {
  query: string
  /** Quantas imagens devolver (1–12). */
  limit: number
  license: LicenseFilter
  providers: ImageProvider[]
  orientation?: Orientation
  /** Largura mínima em px (vídeo pede mais que miniatura). */
  minWidth: number
}

export interface SearchOutcome {
  results: ImageResult[]
  /** Avisos por provedor que falhou ou foi limitado — uma busca parcial ainda vale. */
  warnings: string[]
}

/** Quem faz a requisição: o `fetch` global, ou um dublê nos testes. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
