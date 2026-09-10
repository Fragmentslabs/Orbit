/**
 * Erro de CONFIGURAÇÃO de provedor — não é falha do provedor em si: provedor
 * desconhecido, chave de API ausente, SDK que o Orbit não empacota.
 *
 * Vive num módulo próprio, sem dependências, porque duas camadas precisam dele
 * sem se conhecer: providers.ts (que o lança) e errors.ts (que o classifica
 * como `provider-config`, para a UI traduzir a explicação). Importar
 * providers.ts dentro de errors.ts arrastaria os SDKs de AI junto só por causa
 * de um `instanceof`.
 *
 * O `reason` existe para que a classificação não dependa de casar o texto da
 * mensagem — o texto é diagnóstico e pode mudar de idioma; a razão não.
 */
export type ProviderConfigReason = 'unknown-provider' | 'missing-key' | 'missing-sdk'

export class ProviderResolutionError extends Error {
  constructor(
    message: string,
    readonly reason: ProviderConfigReason,
  ) {
    super(message)
    this.name = 'ProviderResolutionError'
  }
}
