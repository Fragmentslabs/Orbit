import type { CatalogProvider } from '@shared/chat'

/**
 * Pacote que o runtime usa para falar com um provedor. No catálogo quem manda
 * é o `npm` do models.dev; num provedor personalizado (que o models.dev não
 * conhece) quem manda é o `protocol` escolhido no cadastro. Sem nenhum dos
 * dois, cai no adaptador openai-compatible — o mesmo fallback de antes.
 *
 * Mora num módulo próprio (sem imports do app) porque catalog.ts, providers.ts
 * e reasoning/index.ts precisam da MESMA resposta: se o reasoning achasse que
 * o provedor fala openai-compatible enquanto o runtime usa o SDK da Anthropic,
 * o providerOptions sairia no namespace errado e o nível de reasoning se
 * perderia em silêncio.
 */
export function providerRuntimeNpm(
  provider: Pick<CatalogProvider, 'npm' | 'protocol'> | undefined,
): string {
  if (provider?.npm) return provider.npm
  switch (provider?.protocol) {
    case 'anthropic-messages':
      return '@ai-sdk/anthropic'
    case 'openai-responses':
      return '@ai-sdk/openai'
    default:
      return '@ai-sdk/openai-compatible'
  }
}
