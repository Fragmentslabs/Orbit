import { describe, expect, it } from 'vitest'

import { imageVisionGuidance } from './prompts'

/**
 * Os três ramos de "o agente consegue olhar a imagem?".
 *
 * O que está em jogo não é redação: é o agente prometer o que não pode (dizer
 * que vai conferir a foto quando não tem como) ou pedir o que já tem (sugerir
 * ligar a Visão para quem está com ela ligada). Os dois erros são visíveis
 * para o usuário e destroem a confiança na resposta seguinte.
 */

const MODELO_VE = true
const MODELO_CEGO = false
const VISAO_LIGADA = true
const VISAO_DESLIGADA = false

describe('imageVisionGuidance', () => {
  it('modelo de texto com Visão ligada: manda olhar com describe_image', () => {
    const texto = imageVisionGuidance(MODELO_CEGO, VISAO_LIGADA)
    expect(texto).toContain('describe_image')
    expect(texto).toContain('Vision mode is ON')
    // Não pode pedir para ligar o que já está ligado.
    expect(texto).not.toMatch(/turning on Vision mode|Vision mode is off/)
  })

  it('modelo de texto sem Visão: avisa o usuário em vez de fingir precisão', () => {
    const texto = imageVisionGuidance(MODELO_CEGO, VISAO_DESLIGADA)
    expect(texto).toContain('Vision mode is off')
    expect(texto).toContain('turning on Vision mode')
    // E não pode mandar chamar uma tool que não existe nesta configuração.
    expect(texto).not.toContain('describe_image')
  })

  it('modelo que enxerga: não sugere ligar a Visão nem manda olhar o que já viu', () => {
    const texto = imageVisionGuidance(MODELO_VE, VISAO_DESLIGADA)
    expect(texto).toContain('CURRENT message')
    expect(texto).not.toContain('turning on Vision mode')
    expect(texto).not.toContain('describe_image')
  })

  it('modelo que enxerga COM Visão ligada: alcança também a imagem da galeria', () => {
    // A imagem da galeria não está no contexto de ninguém — nem de um modelo
    // com visão. Com a Visão ligada existe caminho; sem ela, não.
    const comVisao = imageVisionGuidance(MODELO_VE, VISAO_LIGADA)
    const semVisao = imageVisionGuidance(MODELO_VE, VISAO_DESLIGADA)
    expect(comVisao).toContain('describe_image')
    expect(semVisao).toContain('ask the user to attach it')
  })

  it('todos os ramos liberam o que NÃO precisa de olhos', () => {
    // Metade das operações mede a própria imagem. Um aviso que desencoraje
    // tudo faria o agente hesitar em redimensionar uma foto.
    for (const [modelo, visao] of [
      [MODELO_VE, VISAO_LIGADA],
      [MODELO_VE, VISAO_DESLIGADA],
      [MODELO_CEGO, VISAO_LIGADA],
      [MODELO_CEGO, VISAO_DESLIGADA],
    ]) {
      const texto = imageVisionGuidance(modelo, visao)
      // Checa a AFIRMAÇÃO, não a redação: o que não pode faltar em ramo nenhum
      // é dizer que essas operações medem a imagem sozinhas.
      expect(texto).toContain('Resizing')
      expect(texto).toContain('removing a background')
      expect(texto).toContain('measure the image themselves')
    }
  })

  it('todos os ramos nomeiam o que depende de ONDE as coisas estão', () => {
    for (const [modelo, visao] of [
      [MODELO_VE, VISAO_LIGADA],
      [MODELO_VE, VISAO_DESLIGADA],
      [MODELO_CEGO, VISAO_LIGADA],
      [MODELO_CEGO, VISAO_DESLIGADA],
    ]) {
      expect(imageVisionGuidance(modelo, visao)).toContain('WHERE things are')
    }
  })
})
