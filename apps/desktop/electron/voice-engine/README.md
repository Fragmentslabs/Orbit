# voice-engine — motor de TTS embutido

Processo filho do main (`utilityProcess.fork`) que roda o **Supertonic 3** em
ONNX Runtime, na CPU, e devolve o áudio **em pedaços** conforme cada pedaço de
texto fica pronto.

| Arquivo | O que é |
|---|---|
| `engine.mjs` | O motor: boot, protocolo com o main, corte em frases, reamostragem 44,1 → 24 kHz e PCM 16-bit em base64 |
| `helper.js` | Cópia **sem alterações** de `supertonic/nodejs/helper.js` (motor upstream) |
| `LICENSE-supertonic.txt` | MIT, do repositório arquivado `supertone-oss-archive/supertonic` |

## Licenças (importante)

- **Código** (`helper.js`, e a referência que `engine.mjs` porta): MIT — pode
  acompanhar o app, está aqui com a licença ao lado.
- **Pesos do modelo**: **OpenRAIL-M** e **nunca entram no build**. Eles são
  baixados pelo usuário para `<userData>/voice/models/supertonic-3`
  (ver `../lib/voice/download.ts` e `../lib/voice/manifest.ts`, que fixam a
  revisão `aafc6e32416a594460b32413efc49d7fe4ce6d46` do HuggingFace e os sha256
  dos quatro `.onnx`). O app nunca redistribui os pesos.

## Uso

```
utilityProcess.fork(".../voice-engine/engine.mjs", ["--assets", "<userData>/voice/models/supertonic-3"])
```

`--assets` aponta para a pasta que contém `onnx/` e `voice_styles/` (a mesma
estrutura do laboratório de referência). Opcionais: `--sample-rate` (24000),
`--steps` (8), `--max-chars` (140).

Por que MessagePort e não stdio: o `utilityProcess.fork` do Electron **não**
aceita `stdin` como pipe — o canal com o filho é o `parentPort`.

## Protocolo

Entrada (`postMessage`):

```jsonc
{ "id": "…", "cmd": "speak", "text": "…", "voice": "F2", "lang": "pt", "speed": 1, "steps": 8, "maxChars": 140 }
{ "cmd": "status" }            // devolve o retrato do motor
{ "cmd": "cancel", "id": "…" } // para entre pedaços; o pedaço em inferência é descartado
{ "cmd": "shutdown" }          // sai limpo (o main mata se não sair)
```

Saída (mesmo formato do laboratório):

```jsonc
{ "type": "ready", "sr": 24000, "nativeSr": 44100, "voices": ["…"], "bootMs": 428, "modelVersion": "v1.7.3" }
{ "id": "…", "start": true, "pieces": 2, "sr": 24000, "voice": "F2", "lang": "pt" }
{ "id": "…", "i": 0, "n": 2, "text": "…", "sr": 24000, "audioMs": 3226, "synthMs": 676, "firstMs": 690, "pcm": "<base64 PCM16 LE>" }
{ "id": "…", "done": true, "pieces": 2, "synthMs": 1739, "audioMs": 8032, "wallMs": 1769, "rtf": 0.22 }
{ "id": "…", "done": true, "error": "…" }
```

Logs vão para o **stderr** (o main os repassa ao console como `[voice-engine]`).

## Medições deste motor (Mac Apple Silicon, CPU, `steps=8`)

| Fala | Pedaços | 1º áudio | Síntese | Áudio | RTF |
|---|---|---|---|---|---|
| "Olá, esta é uma frase de teste…" (105 chars, F2, pt) | 1 | 1920 ms | 1893 ms | 8568 ms | 0,22 |
| Duas frases com corte em 40 chars (F2, pt) | 2 | 690 ms | 1739 ms | 8032 ms | 0,22 |

Boot (carregar os 4 ONNX + 10 vozes): **~430 ms**. O streaming começa a tocar
com menos de 1 s de pedido feito, contra os ~1,9 s do texto inteiro pronto.
