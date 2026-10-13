/**
 * Guia de ofício da edição de vídeo, para o MODELO (por isso em inglês).
 *
 * Fica fora do system prompt: são ~2k tokens que só valem quando há vídeo na
 * conversa. O prompt leva só um parágrafo (VIDEO_INSTRUCTION em prompts.ts)
 * mandando chamar `video_guide` antes do primeiro corte. Baseado nas regras de
 * produção do video-use (browser-use), adaptadas às tools do Orbit — o que lá
 * era regra para o modelo lembrar, aqui o render já faz sozinho.
 */

const EDITING = `# Video editing — workflow and craft

## Principle
You READ footage, you don't watch it. The word-timed transcript (video_transcribe) is your main view; video_timeline images are for decision points only. Decisions go into an EDL; video_render applies them deterministically.

## Workflow (ask → confirm → execute → self-check → persist)
1. Inventory: video_probe every source; video_transcribe all of them in one call (ids A, B, C… or take1…). Look at 2–3 video_timeline windows to know what the footage looks like (framing, light, b-roll vs talking head).
2. Pre-scan the transcript: false starts, retakes ("let me start again"), fillers (um, uh, "like"), verbal slips, dead air (· silence ·), the best take of each idea.
3. Converse: ask what the material calls for — target length, platform/aspect (16:9, 9:16, 1:1), pacing, subtitles or not, tone of the grade, music. Ask only what you cannot infer.
4. Propose a strategy in 4–8 sentences (structure by beats, what goes, target duration) and WAIT for the user's OK before cutting. Never edit before approval.
5. Execute: write the EDL (save it as edit/edl.json so it can be revised), render a preview (preview: true).
6. Self-check (mandatory, max 3 passes): video_timeline on the OUTPUT around every cut point it returned (±1.5 s, marks = the cut). Look for: a clipped word, a visual jump, a breath cut in half, subtitles hidden behind an overlay, an overlay off its moment. Read the loudness numbers. Fix the EDL and re-render.
7. Render the final (preview: false) only when the preview passes; report what you measured (duration, loudness, cuts) — you cannot hear, never claim it "sounds good".
8. Persist: append a dated section to edit/project.md — strategy, decisions and why, open items — so a later session resumes from there. A new session on the same folder starts by reading it.

## Cut craft
- Audio is primary, picture follows: cut on speech boundaries and silences.
- Silence ≥ 400 ms: cleanest cut. 150–400 ms: usable, check with video_timeline. < 150 ms: unsafe (mid-phrase).
- Never cut inside a word (video_render snaps edges out of words and keeps ~80 ms of air; padMs 30–200 changes it).
- Keep laughs and reactions that land; give speaker handoffs 400–600 ms of air.
- Remove: false starts, repeated takes (keep the best — usually the last clean one), fillers, dead air > ~0.7 s inside a thought.
- A range is [start, end] in SOURCE seconds; the output is the ranges in order. Reordering is allowed (hook first).

## EDL (video_render)
{
  "sources": { "A": "footage/take1.mp4", "B": "footage/take2.mp4" },
  "ranges": [
    { "source": "A", "start": 2.40, "end": 7.85, "beat": "HOOK", "quote": "…", "reason": "cleanest delivery" },
    { "source": "B", "start": 12.10, "end": 31.02, "beat": "BODY" }
  ],
  "output": { "width": 1080, "height": 1920, "fps": 30, "fit": "cover" },
  "grade": "neutral_punch",
  "overlays": [ { "file": "edit/animations/title.mov", "start": 0.5, "x": 0, "y": 0 } ],
  "subtitles": { "style": "bold-overlay" },
  "music": { "file": "assets/bed.mp3", "volumeDb": -20, "duck": true },
  "loudness": { "target": -14 }
}
- output defaults to the first source's size/fps; fit "contain" letterboxes, "cover" crops (use cover for 9:16 from 16:9 talking heads).
- grade: warm_cinematic (subtle teal/orange, a bit desaturated), neutral_punch (contrast only), cool_clean, none — or a raw ffmpeg filter chain (e.g. "eq=contrast=1.08:saturation=1.1"). Per-range "grade" overrides. Judge a grade on a timeline frame, change one thing at a time, protect skin tones.
- overlays: start is in OUTPUT seconds; x/y accept ffmpeg expressions without commas ("(W-w)/2", "W-w-40"). Alpha is kept for .mov ProRes 4444 and .webm VP9 (motion_render transparent: true produces them).
- subtitles: generated from the transcript, timed to the OUTPUT and burned last. bold-overlay = 2-word UPPERCASE bold chunks in the lower third (social); natural-sentence = sentence case, up to ~7 words (documentary/tutorial). Tune with wordsPerChunk, uppercase, font, fontSize, position, marginV, colors — or pass your own .srt/.ass (OUTPUT times) in "file".
- music: ducked under speech by default (~10 dB when someone talks). Keep it 18–22 dB under the voice.
- loudness: -14 LUFS integrated / -1 dBTP true peak by default (streaming platforms). false to skip.

## Beyond the EDL
The bash tool has ffmpeg and ffprobe (the app ships them). Use them for what the EDL does not cover (speed ramps, stabilization, reframing with a moving crop, exporting stills, GIFs, extracting audio). Write outputs under edit/, never over the user's sources, then show_video the result.

## Sound
Few effects, each tied to something visible. No stock whoosh on every transition. Audio fades at every cut are automatic.

## Anti-patterns
Editing before the plan is approved · re-transcribing unchanged files · scanning whole videos with images · cutting by fixed seconds instead of words · linear easing in animations · unverified fonts · subtitles before overlays (the render already prevents this) · claiming how it sounds instead of reporting measurements.`

const MOTION = `# Motion graphics (motion_render)

Write the animation as one self-contained HTML file (edit/animations/<slot>/index.html) and render it with motion_render. The app's own Chromium renders it frame by frame: deterministic, no network needed (but a CDN script works if the machine is online — prefer a local copy of GSAP in the folder for reproducibility).

## Contract
- Declare the format: <meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=4"> (or window.orbitMotion = { width, height, fps, duration }, or pass them to the tool).
- Time only advances by seeking. Supported automatically: GSAP (window.orbitTimeline if you expose your main timeline — recommended — otherwise the global timeline), CSS animations/transitions and the Web Animations API, <video> elements. For canvas/WebGL/anything else, implement window.orbitMotion.seek(t) (seconds; may return a Promise) and draw the frame for t there.
- requestAnimationFrame loops with their own clock, setTimeout/setInterval and Date.now() do NOT advance — they render frozen.
- For an overlay with alpha: transparent: true, output .mov (ProRes 4444) or .webm, and keep html/body background transparent.
- Size the page exactly to the declared width/height (html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden }).

## Craft
- Ease out/in-out (power2/power3, cubic-bezier) — never linear for UI or type motion.
- Sync the payoff: land the key word/number on the frame the narrator says it (take the word time from the transcript, convert to the overlay's local time).
- Hold the final frame ≥ 1 s before an overlay ends; enter in 300–600 ms.
- Text must be readable on a phone: large, high contrast, short.
- Fonts: load them from local files with @font-face; motion_render warns when a font failed (the fallback is silent otherwise).
- Check the render with video_timeline at the key moments before placing it in the EDL.
- Several independent animations? Delegate each to a sub-agent in parallel (subagent tool) with a self-contained brief: file path, size/fps/duration, exact text, timing of the payoff word, palette, transparent or not.

## Minimal GSAP skeleton
<!doctype html><html><head>
<meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=4">
<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:transparent}
.t{position:absolute;left:120px;bottom:160px;font:800 96px/1 Inter,Arial,sans-serif;color:#fff}</style>
<script src="gsap.min.js"></script></head><body><div class="t" id="t">Ship faster.</div>
<script>
const tl = gsap.timeline()
tl.from('#t', { y: 60, opacity: 0, duration: 0.5, ease: 'power3.out' })
  .to('#t', { opacity: 0, duration: 0.4, ease: 'power2.in' }, 3.4)
window.orbitTimeline = tl
</script></body></html>`

const REMOTION = `# Remotion (React video) — when the user wants it

Remotion is NOT bundled with Orbit. Licensing: free for individuals, non-profits and companies with up to 3 employees; larger companies need a paid company license (remotion.pro). Tell the user this once before setting it up for a company project. Prefer motion_render for one-off motion graphics; use Remotion when the user asks for it, the project already uses it, or the video is data/component driven (many variants from props).

## Setup in the working folder (non-interactive)
npm init -y (if there is no package.json)
npm i remotion @remotion/cli react react-dom
Create remotion/index.ts:
  import { registerRoot } from 'remotion'; import { Root } from './Root'; registerRoot(Root)
Create remotion/Root.tsx with <Composition id="Main" component={Main} durationInFrames={150} fps={30} width={1920} height={1080} defaultProps={{…}} />.
Animate with useCurrentFrame(), interpolate() and spring() — never CSS transitions or timers (Remotion renders frames independently).

## Render
npx remotion render remotion/index.ts Main edit/animations/main.mp4
- With props: --props='{"title":"…"}' (or a JSON file path).
- Alpha overlay: --codec=prores --prores-profile=4444 --pixel-format=yuva444p10le to a .mov, or --codec=vp9 --pixel-format=yuva420p to a .webm.
- The first render downloads Chrome Headless Shell (~100 MB) — say so; it needs network once.
- Preview for the user: npx remotion studio (runs a local server; use the panel browser to look at it).
Then place the clip in the EDL as an overlay, or show_video it.`

export const VIDEO_GUIDES = { editing: EDITING, motion: MOTION, remotion: REMOTION } as const
export type VideoGuideTopic = keyof typeof VIDEO_GUIDES
