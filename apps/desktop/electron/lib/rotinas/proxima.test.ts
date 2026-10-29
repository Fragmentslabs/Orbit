import { describe, expect, it } from 'vitest'
import { proximaExecucao } from '@shared/rotinas'

/**
 * Testes do cálculo de próxima execução — o coração do scheduler. Horários
 * escolhidos longe da meia-noite para valerem em qualquer fuso local.
 */

// hh já é "HH:MM" — acrescenta só os segundos.
const DIA = (d: string, hh: string) => new Date(`${d}T${hh}:00`).getTime()

describe('proximaExecucao — agendas clássicas', () => {
  it('diário: próximo horário de hoje quando ainda não passou', () => {
    const alvo = proximaExecucao({ horario: '09:00' }, DIA('2026-10-29', '08:00'))
    expect(alvo).toBe(DIA('2026-10-29', '09:00'))
  })

  it('diário: vai para amanhã quando o horário já passou', () => {
    const alvo = proximaExecucao({ horario: '09:00' }, DIA('2026-10-29', '10:00'))
    expect(alvo).toBe(DIA('2026-10-30', '09:00'))
  })

  it('semanal: respeita os dias marcados, pulando a semana inteira', () => {
    // 2026-10-29 é uma sexta (5); com só segunda (1), o próximo é 02/11
    const alvo = proximaExecucao({ horario: '12:00', dias: [1] }, DIA('2026-10-29', '08:00'))
    expect(alvo).toBe(DIA('2026-11-02', '12:00'))
  })

  it('intervalo em dias: conta da última execução', () => {
    const ultima = DIA('2026-10-26', '12:00')
    const alvo = proximaExecucao({ horario: '12:00', intervaloDias: 3 }, DIA('2026-10-29', '08:00'), ultima)
    expect(alvo).toBe(DIA('2026-10-29', '12:00'))
  })

  it('horário inválido: null em vez de chutar', () => {
    expect(proximaExecucao({ horario: '09:0' }, DIA('2026-10-29', '08:00'))).toBeNull()
  })
})

describe('proximaExecucao — a cada N horas', () => {
  it('sem execução anterior: a primeira cai no horário do dia', () => {
    const alvo = proximaExecucao({ horario: '09:00', intervaloHoras: 4 }, DIA('2026-10-29', '07:00'))
    expect(alvo).toBe(DIA('2026-10-29', '09:00'))
  })

  it('com execução anterior: soma N horas a partir dela', () => {
    const ultima = DIA('2026-10-29', '06:00')
    const alvo = proximaExecucao({ horario: '09:00', intervaloHoras: 4 }, DIA('2026-10-29', '07:00'), ultima)
    expect(alvo).toBe(DIA('2026-10-29', '10:00'))
  })

  it('janela perdida longa: salto em O(1), sem laço de horas', () => {
    const ultima = DIA('2026-10-01', '09:00')
    const alvo = proximaExecucao({ horario: '09:00', intervaloHoras: 6 }, DIA('2026-10-20', '08:00'), ultima)
    expect(alvo).toBeGreaterThan(DIA('2026-10-20', '08:00'))
    // Múltiplo exato do intervalo contado da última execução
    const saltos = (alvo! - ultima) / (6 * 3600_000)
    expect(saltos % 1).toBe(0)
  })
})

describe('proximaExecucao — uma vez só', () => {
  it('data futura: devolve o único disparo', () => {
    const alvo = proximaExecucao({ horario: '08:30', umaVezData: '2026-11-05' }, DIA('2026-10-29', '08:00'))
    expect(alvo).toBe(DIA('2026-11-05', '08:30'))
  })

  it('data já passada: nunca dispara (o scheduler a desativa)', () => {
    expect(proximaExecucao({ horario: '08:30', umaVezData: '2026-10-01' }, DIA('2026-10-29', '08:00'))).toBeNull()
  })

  it('data inválida: null em vez de adivinhar', () => {
    expect(proximaExecucao({ horario: '08:30', umaVezData: '31/10/2026' }, DIA('2026-10-29', '08:00'))).toBeNull()
  })

  it('precede intervaloHoras quando os dois estão preenchidos', () => {
    const alvo = proximaExecucao(
      { horario: '08:30', umaVezData: '2026-11-05', intervaloHoras: 4 },
      DIA('2026-10-29', '08:00'),
    )
    expect(alvo).toBe(DIA('2026-11-05', '08:30'))
  })
})
