---
name: Media Compress
description: Compress video and audio to a byte ceiling or a quality target — codec/bitrate decisions, container pitfalls and verification. Use when the user asks to shrink, convert or extract audio from a media file, or to make it fit an upload limit.
slug: media_compress
---

# Media Compress

Make a video or audio file smaller without guessing. The goal is a file that
meets a real constraint — an upload limit, a chat attachment, a slower
connection — and that still opens and plays.

**Not this skill:** images. `image_edit` already compresses to `maxBytes`,
resizes and converts, and it measures the result itself. Do not run ffmpeg on a
photo.

## First: the tool, not the shell

`media_compress` does the whole job deterministically: it probes the source,
computes the bitrate budget, encodes, **re-probes the output**, and retries with
a corrected bitrate (up to 3 attempts) when a byte ceiling is missed. It never
touches the source file.

Use it for: "compress this video", "under 25 MB", "in 720p", "convert to
mp3", "extract the audio", "remove the audio" — in any language.

Only reach for `bash` + ffmpeg when the tool genuinely does not cover it:

- batch over many files with the same settings (loop, but still one tool call
  per file — or a shell loop when the tool is not available in the turn);
- filters the tool does not expose (cropping, burning subtitles, changing speed);
- formats outside the tool's list (GIF, WAV export, ProRes).

## What to ask the user (or decide) before encoding

1. **The real constraint.** "Comprimir" is not a goal. A byte ceiling, a
   resolution, or a quality level is. If the user gave none, ask — or pick a
   byte ceiling from the destination (WhatsApp ≈ 16 MB, most web uploads 25–100
   MB) and say which one you used.
2. **The floor.** Compression that destroys the material is not a win: below
   ~480p or ~60 kbps of video, a talking-head video stops being usable. Say so
   instead of delivering mud.
3. **The audio.** For speech, 64–96 kbps mono Opus/AAC is plenty; for music,
   128–192 kbps stereo. Dropping the audio is legitimate when the video is
   silent or the user only wants the picture.

## The decisions that actually matter

- **Target size → bitrate.** `video_kbps = (maxBytes × 8 × 0.97 / duration_s) −
  audio_kbps − ~6` (container overhead). Never encode to a byte target without
  this math: CRF gives you a nice file, not a guaranteed size.
- **One pass, CBR-ish, for a byte ceiling** (`-b:v Nk -maxrate Nk -bufsize 2Nk`).
  Two-pass is only worth it when quality at a fixed size is critical and the
  encode time is acceptable.
- **CRF for "make it smaller, quality first"** — H.264 CRF 23 is a good default,
  18 is near-transparent, 28 is visibly softer. HEVC needs roughly CRF +5 and
  AV1/VP9 +8 for the same perceived quality.
- **Codec by destination.** H.264/MP4 plays everywhere. HEVC is ~30–50% smaller
  for the same quality but not universal on the web. AV1 is smaller still and
  slow to encode. VP9 lives in WebM.
- **Scale before you starve.** Halving the resolution (`scale=-2:720`) often
  looks better than keeping 1080p at a bitrate too low for it.
- **Keep 10-bit as 10-bit.** 10-bit sources (HDR, phone HDR video) converted to
  8-bit H.264 without tone mapping look washed. Prefer HEVC/AV1, or say that
  the colours will shift.
- **Never upscale** height or fps; that inflates the file without adding detail.

## Pitfalls that bite

- **Already-compressed sources.** Re-encoding an MP3 or a low-bitrate MP4 at a
  higher bitrate does not restore anything — it adds generation loss. If the
  file already fits, say so instead of re-encoding.
- **Rotation.** Phone video carries a rotation matrix. Modern ffmpeg bakes it in
  during re-encode; verify the output height/width after, because a "720p" that
  comes out 1280×720 from a 720×1280 source means the rotation was applied.
- **VFR screen recordings.** Variable frame rate is normal in captures; forcing
  `-r 30` duplicates frames and grows the file. Leave the timing alone unless
  the target player requires CFR (then `-fps_mode cfr -r 30`).
- **Multiple streams.** Map explicitly: `-map 0:v:0 -map 0:a:0?`. Plain `-map 0`
  carries subtitles, chapters and data streams that the target format may not
  accept — and `-sn -dn` keeps them out.
- **Cover art.** In MP3/M4A the artwork is a video stream (`attached_pic`).
  `-vn` drops it; that is usually fine, but the user may notice the missing
  album cover.
- **Duration check.** A truncated or over-long output is the classic silent
  failure. Always compare the output duration to the source (the tool does it).

## Manual recipes (when the tool cannot be used)

Byte ceiling, one pass (replace N with the computed kbps):

```bash
ffmpeg -i in.mp4 -map 0:v:0 -map 0:a:0? -c:v libx264 -preset medium \
  -b:v Nk -maxrate Nk -bufsize 2Nk -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart out.mp4
```

Quality first: `-crf 23` instead of the three bitrate flags.

Extract audio: `ffmpeg -i in.mp4 -vn -c:a libmp3lame -b:a 160k out.mp3`
(use `aac`/`.m4a` or `libopus`/`.opus` when the player accepts them — Opus is
better at the same bitrate).

Verify, always:

```bash
ffprobe -v error -show_entries format=duration,size,bit_rate -show_entries stream=codec_name,width,height -of json out.mp4
```

Batch (same settings for every file):

```bash
for f in *.mov; do
  ffmpeg -v error -i "$f" -c:v libx264 -crf 23 -c:a aac -b:a 128k "compressed/${f%.mov}.mp4"
done
```

## Reporting

Give the user the numbers, not an adjective: before → after size, the
percentage, the resolution change, and any caveat (10-bit source, target below
what is achievable, audio dropped). If a byte target was missed, say it plainly
and offer the next step (lower the resolution, shorten the clip, split the file).
