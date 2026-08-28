/**
 * O desktop se identifica com o `hostname()` cru do sistema, que no macOS vem
 * como "MacBook-Air-de-Desknik.local" e no Windows como "DESKTOP-4F2K9". Guardar
 * o valor cru é certo (é o nome real da máquina na rede); o que não presta é
 * mostrá-lo assim.
 *
 * Formata só na exibição: tira o sufixo mDNS e troca os separadores por espaço.
 */
export function prettyDeviceName(name?: string | null): string | undefined {
  if (!name) return undefined
  const withoutMdns = name.trim().replace(/\.local\.?$/i, '')
  const spaced = withoutMdns.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return spaced || undefined
}
