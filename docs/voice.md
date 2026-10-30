# Voice (STT/TTS)

Orbit's local speech feature: **dictation (STT)** and **read aloud (TTS)**,
all processed on the machine itself. No audio leaves for the cloud because of this
feature.

## What it is

- **TTS — Supertonic 3 (Supertone).** Local voice synthesis via ONNX Runtime (CPU),
  10 pre-trained voices (`M1–M5`, `F1–F5`), multilingual (31 languages, `pt`
  included). It supports **streaming per text chunk**: the synthesis is cut by
  sentence and each chunk is emitted as soon as it is ready, so the sound starts
  before the whole synthesis finishes. Audio served at 24 kHz, mono, 16-bit.
- **STT — Parakeet / whisper.** Two recognition families:
  - **NVIDIA Parakeet TDT 0.6B v3** (via sherpa-onnx, CPU only): covers 25
    European languages (including `pt`) and detects the language on its own. It is
    the candidate for Windows/Linux. The `sherpa-onnx-node` interface is N-API
    (stable ABI), so it runs in Electron without recompiling.
  - **whisper.cpp** (OpenAI Whisper models converted to ggml; binding
    `smart-whisper`): multiple sizes, from `tiny` to `large-v3-turbo`.

The models **are not part of the app's build nor distribution**. They are
downloaded **on demand, at the user's request**, and stay on the local disk.

## Where the files live in the repo

| Path | Role |
|---|---|
| `apps/desktop/electron/lib/voice/` | Voice module of the Electron main process |
| `apps/desktop/electron/lib/voice/manifest.ts` | Manifest/catalog of the offered models and their metadata |
| `apps/desktop/electron/lib/voice/stt.ts` | STT engine (Parakeet/whisper) |

> Note: at the time this document was written, the directory
> `apps/desktop/electron/lib/voice/` and its files still **did not exist** in this
> worktree — the model list below comes from the decision lab in
> `/Users/desknik/Projects/Testes` (vozlab + supertonic-tts). If the real
> implementation brings a different list, `manifest.ts` is the source of truth and
> this document must be aligned with it.

## Downloaded models, from where and under which licenses

### TTS — Supertonic 3 (weights)

- **Origin:** Hugging Face `supertone-oss-archive/supertonic-3`
  (<https://huggingface.co/supertone-oss-archive/supertonic-3>).
- **Weights license:** **OpenRAIL-M** (text with usage restrictions at
  <https://huggingface.co/supertone-oss-archive/supertonic-3/blob/main/LICENSE>).
- **SDK/helper license:** MIT (Supertone Inc.).
- The weights are **downloaded on demand by the user** and **are not part of the
  app's build/distribution**.

### STT — whisper.cpp (ggml models)

- **Origin:** Hugging Face `ggerganov/whisper.cpp`, downloaded into a local models
  folder (`https://huggingface.co/ggerganov/whisper.cpp`).
- **License:** OpenAI Whisper (original model) is MIT; whisper.cpp/ggml is MIT.
- **Offered models:** `tiny`, `base`, `small`, `medium` (`ggml-medium-q5_0`),
  `large-v3-turbo` (`ggml-large-v3-turbo-q5_0`) — and, in the lab, also
  `large-v3-turbo-f16` and `distil-large-v3.5` (this one English-only, from
  `distil-whisper/distil-large-v3.5-ggml`).
- **Binding:** `smart-whisper` (MIT).

### STT — Parakeet TDT 0.6B v3

- **Origin:** distributed by sherpa-onnx as
  `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, downloaded on demand from the
  `https://github.com/k2-fsa/sherpa-onnx/releases` releases (together with Silero VAD).
- **Model license:** **CC-BY-4.0** — upstream NVIDIA model
  (<https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>).
- **Runtime license:** sherpa-onnx is Apache-2.0.
- **ONNX Runtime** (`onnxruntime` / `onnxruntime-node`): MIT.

The complete license texts and the attribution notices are in the
[`NOTICE`](../NOTICE) file, in the section "Third-party notices — voice (STT/TTS)".

## How to enable / disable

- **Disabled by default:** no model is downloaded or run without an explicit
  action from the user. The download of each model (Supertonic 3, Parakeet, the
  whisper models) is started **on demand** and can be removed from the disk
  later, without affecting the rest of the app.
- **Enable:** turn the voice feature on in the app settings and choose the
  engine/model; the download of the corresponding model is triggered there. For
  Supertonic 3 (TTS) and Parakeet (STT), the first use downloads the weights;
  afterwards everything runs 100% offline.
- **Disable:** turn the feature off in the settings and/or delete the downloaded
  model files, freeing the disk space. Since the weights are not part of the
  distribution, turning the feature off only interrupts the use, it does not
  require reinstalling the app.

> Implementation details (exact messages, toggles and option names) must be
> confirmed in the `apps/desktop/electron/lib/voice/` module when it exists in
> this worktree.
