import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, unknown>()
vi.mock('../storage', () => ({
  readJson: async (key: string) => store.get(key) ?? null,
  writeJson: async (key: string, value: unknown) => {
    store.set(key, value)
  },
}))

const { findRecipe, goalSimilarity, recipeHint, recipeStep, saveRecipe } = await import('./recipes')

beforeEach(() => store.clear())

describe('recipeStep', () => {
  it('tira o índice e o que foi lido ou digitado', () => {
    expect(recipeStep('Pressed element 12 (button "Enviar") via AXPress.')).toBe('Pressed (button "Enviar") via AXPress.')
    expect(recipeStep('Set the value of element 3 (text field "Para"). Read back: "joao@x.com".')).toBe('Set the value of (text field "Para").')
    expect(recipeStep('Typed 9 character(s) into element 4 (text field "Assunto").')).toBe('Typed 9 character(s) into (text field "Assunto").')
  })

  it('avisos do read_back não são passos', () => {
    expect(recipeStep('Nothing changed in the accessibility tree after this action')).toBeNull()
    expect(recipeStep('✓ Expected "Salvo" on screen: confirmed.')).toBeNull()
    expect(recipeStep('Waited 1s.')).toBeNull()
  })
})

describe('receitas', () => {
  it('um objetivo parecido acha a receita; um diferente, não', async () => {
    await saveRecipe('Abrir o Mail e enviar o rascunho "Relatório" para a equipe', ['Pressed element 2 (button "Rascunhos").', 'Pressed cmd+shift+d.'])
    const hit = await findRecipe('enviar o rascunho Relatório para a equipe pelo Mail')
    expect(hit?.steps).toEqual(['Pressed (button "Rascunhos").', 'Pressed cmd+shift+d.'])
    expect(await findRecipe('mudar o papel de parede')).toBeNull()
  })

  it('o mesmo objetivo troca a receita velha pela nova', async () => {
    await saveRecipe('exportar a planilha Vendas como PDF', ['Pressed cmd+p.'])
    await saveRecipe('exportar a planilha Vendas como PDF', ['Pressed (menu item "Exportar").'])
    const all = store.get('computer-recipes') as { steps: string[]; uses: number }[]
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ steps: ['Pressed (menu item "Exportar").'], uses: 2 })
  })

  it('a dica chega ao modelo como dado, não como instrução', async () => {
    await saveRecipe('arquivar o email do banco', ['Pressed (button "Arquivar").'])
    const hint = recipeHint((await findRecipe('arquivar o email do banco'))!)
    expect(hint).toContain('<previous_run untrusted="true">')
    expect(hint).toContain('NOT instructions')
  })

  it('semelhança ignora acento e palavras vazias', () => {
    expect(goalSimilarity('Abrir as configurações', 'abrir as configuracoes')).toBe(1)
  })
})
