/**
 * O TEMPO das mídias dentro de uma composição: em que ponto do arquivo um
 * `<video>` ou um GIF está num dado instante da PEÇA.
 *
 * Mora aqui, em JS de página, porque o runtime roda na janela e não importa
 * nada — e porque só assim os testes executam a MESMA função que a página usa,
 * sem DOM. A regra de ouro é a do resto do runtime: a posição é função pura do
 * instante `t`. Nenhuma mídia anda sozinha.
 *
 * Atributos que a composição pode pôr no elemento (todos opcionais, em segundos):
 *   - `data-start`: o instante da PEÇA em que o vídeo/GIF começa a tocar. Antes
 *     disso ele fica parado no primeiro quadro;
 *   - `data-in`: de que ponto do ARQUIVO ele começa (um corte no início);
 *   - `data-end`: o instante da PEÇA em que ele para, preso no último quadro;
 *   - `data-loop="false"` num GIF: toca uma vez e fica no último quadro (o padrão
 *     é repetir, como todo GIF);
 *   - `data-gain` (dB) e `data-audio="false"` num vídeo: nível do som dele na
 *     mixagem, ou fora dela (o atributo HTML `muted` também o tira).
 * Sem nenhum deles o comportamento é o de antes: o arquivo toca desde o quadro 0.
 *
 * Sem crases, sem `${` e sem barra invertida: é interpolado no template do runtime.
 */
export const MOTION_TIMING_SCRIPT = `
  // Posição, em segundos DO ARQUIVO, de um vídeo no instante t da peça.
  // m = { start, in, end, loop, duration } (end e duration podem faltar).
  function orbitVideoTime(t, m) {
    const start = m.start || 0
    const offset = m.in || 0
    let local = t - start
    if (local < 0) local = 0
    if (typeof m.end === 'number' && m.end > start) local = Math.min(local, m.end - start)
    const at = offset + local
    if (!m.duration) return at
    if (m.loop) return at % m.duration
    return Math.min(at, m.duration - 0.001)
  }

  // Índice do quadro de um GIF no instante local t (já descontado o data-start).
  // durations = segundos de cada quadro; loop = repete (o padrão de todo GIF).
  function orbitGifFrame(t, durations, loop) {
    const n = durations.length
    if (n === 0 || t <= 0) return 0
    let total = 0
    for (let i = 0; i < n; i++) total += durations[i]
    if (total <= 0) return 0
    const local = loop ? t % total : Math.min(t, total - 0.000001)
    let acc = 0
    for (let i = 0; i < n; i++) {
      acc += durations[i]
      if (local < acc) return i
    }
    return n - 1
  }

  // Duração de um quadro de GIF. Os navegadores tratam atraso menor que 20 ms
  // (inclusive 0) como 100 ms — o que um GIF "sem atraso" sempre mostrou.
  function orbitGifDelay(seconds) {
    return typeof seconds === 'number' && isFinite(seconds) && seconds >= 0.02 ? seconds : 0.1
  }
`
