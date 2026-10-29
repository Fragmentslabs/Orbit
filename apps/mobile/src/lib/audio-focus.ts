/**
 * Um player por vez no app.
 *
 * Três coisas disputam a mesma saída de áudio: o player de um áudio do agente
 * (`AudioPartView`), o da galeria e a leitura em voz alta de uma resposta. Sem
 * um dono, dois tocam juntos e a pessoa não sabe qual pausar — cada player só
 * conhece a si mesmo.
 *
 * Quem assume o foco pausa o anterior e é AVISADO quando perde o foco
 * (`onPreempted`), porque quem manda no player nem sempre deriva o estado dele:
 * a bolha do áudio lê `status.playing` e se corrige sozinha, mas o botão de
 * falar guarda o próprio estado e ficaria em "parar" falando nada.
 */
import type { AudioPlayer } from 'expo-audio'

let active: AudioPlayer | null = null
/** O que fazer quando ESTE dono perder o foco (o próximo assume). */
let preempted: (() => void) | null = null

/** Assume o áudio: pausa quem estava tocando e passa a ser o dono. */
export function claimAudioFocus(player: AudioPlayer, onPreempted?: () => void): void {
  if (active && active !== player) {
    try {
      active.pause()
    } catch {
      // Player já liberado (tela desmontada no meio) — nada a pausar.
    }
    const anterior = preempted
    preempted = null
    anterior?.()
  }
  active = player
  preempted = onPreempted ?? null
}

/** Devolve o foco, se ainda for o dono (parar um player que já perdeu o foco
 *  não pode derrubar o foco de quem está tocando agora). */
export function releaseAudioFocus(player: AudioPlayer): void {
  if (active !== player) return
  active = null
  preempted = null
}
