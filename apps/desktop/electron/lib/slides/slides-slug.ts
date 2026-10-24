/**
 * O slug de um deck — o nome da pasta dele no armazenamento do Orbit.
 *
 * Vive num módulo próprio porque DUAS pontas precisam concordar: quem ESCREVE
 * (`slides_write` cria `orbit-data/slides/<sessão>/<slug>/`) e quem PROCURA
 * (`slidesIdForName`, quando o card da conversa manda o título do deck e não o
 * caminho). Sem a mesma função nos dois lados, o card de um deck escrito no
 * chat não reabriria nada.
 *
 * "Orbit em 12 slides" → "orbit-em-12-slides". Mesmo algoritmo do designSlug.
 */
export function slidesSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'deck'
}
