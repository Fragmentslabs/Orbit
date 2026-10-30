# voice-engine — the built-in TTS engine

Child process of the main (`utilityProcess.fork`) that runs **Supertonic 3** on
ONNX Runtime, on the CPU, and returns the audio **in pieces** as each piece of
text becomes ready.

| File | What it is |
|---|---|
| `engine.mjs` | The engine: boot, protocol with the main, splitting into sentences, resampling 44.1 → 24 kHz and 16-bit PCM in base64 |
| `helper.js` | **Unchanged** copy of `supertonic/nodejs/helper.js` (upstream engine) |
| `LICENSE-supertonic.txt` | MIT, from the archived repository `supertone-oss-archive/supertonic` |

## Licenses (important)

- **Code** (`helper.js`, and the reference that `engine.mjs` ports): MIT — it may
  ship with the app, and it is here with the license next to it.
- **Model weights**: **OpenRAIL-M** and they **never enter the build**. They are
  downloaded by the user to `<userData>/voice/models/supertonic-3`
  (see `../lib/voice/download.ts` and `../lib/voice/manifest.ts`, which pin the
  HuggingFace revision `aafc6e32416a594460b32413efc49d7fe4ce6d46` and the sha256
  of the four `.onnx` files). The app never redistributes the weights.

## Usage

```
utilityProcess.fork(".../voice-engine/engine.mjs", ["--assets", "<userData>/voice/models/supertonic-3"])
```

`--assets` points to the folder that holds `onnx/` and `voice_styles/` (the same
structure as the reference lab). Optional: `--sample-rate` (24000),
`--steps` (8), `--max-chars` (140).

Why MessagePort and not stdio: the Electron `utilityProcess.fork` does **not**
accept `stdin` as a pipe — the channel with the child is the `parentPort`.

## Protocol

Input (`postMessage`):

```jsonc
{ "id": "…", "cmd": "speak", "text": "…", "voice": "F2", "lang": "pt", "speed": 1, "steps": 8, "maxChars": 140 }
{ "cmd": "status" }            // returns the engine snapshot
{ "cmd": "cancel", "id": "…" } // stops between pieces; the piece in inference is discarded
{ "cmd": "shutdown" }          // exits cleanly (the main kills it if it does not)
```

Output (same format as the lab):

```jsonc
{ "type": "ready", "sr": 24000, "nativeSr": 44100, "voices": ["…"], "bootMs": 428, "modelVersion": "v1.7.3" }
{ "id": "…", "start": true, "pieces": 2, "sr": 24000, "voice": "F2", "lang": "pt" }
{ "id": "…", "i": 0, "n": 2, "text": "…", "sr": 24000, "audioMs": 3226, "synthMs": 676, "firstMs": 690, "pcm": "<base64 PCM16 LE>" }
{ "id": "…", "done": true, "pieces": 2, "synthMs": 1739, "audioMs": 8032, "wallMs": 1769, "rtf": 0.22 }
{ "id": "…", "done": true, "error": "…" }
```

Logs go to **stderr** (the main relays them to the console as `[voice-engine]`).

## Measurements of this engine (Apple Silicon Mac, CPU, `steps=8`)

| Speech | Pieces | 1st audio | Synthesis | Audio | RTF |
|---|---|---|---|---|---|
| "Olá, esta é uma frase de teste…" (105 chars, F2, pt) | 1 | 1920 ms | 1893 ms | 8568 ms | 0.22 |
| Two sentences split at 40 chars (F2, pt) | 2 | 690 ms | 1739 ms | 8032 ms | 0.22 |

Boot (loading the 4 ONNX files + 10 voices): **~430 ms**. Streaming starts playing
under 1 s from the request, against the ~1.9 s of the whole text being ready.
