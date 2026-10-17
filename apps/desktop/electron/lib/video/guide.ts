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
- overlays: start is in OUTPUT seconds; x/y accept ffmpeg expressions without commas ("(W-w)/2", "W-w-40"). Alpha is kept for .mov ProRes 4444 and .webm VP9 (motion_render produces them with format "mov-alpha" / "webm-alpha").
- subtitles: generated from the transcript, timed to the OUTPUT and burned last. bold-overlay = 2-word UPPERCASE bold chunks in the lower third (social); natural-sentence = sentence case, up to ~7 words (documentary/tutorial). Tune with wordsPerChunk, uppercase, font, fontSize, position, marginV, colors — or pass your own .srt/.ass (OUTPUT times) in "file".
- music: ducked under speech by default (~10 dB when someone talks). Keep it 18–22 dB under the voice.
- loudness: -14 LUFS integrated / -1 dBTP true peak by default (streaming platforms). false to skip.

## Beyond the EDL
The bash tool has ffmpeg and ffprobe (the app ships them). Use them for what the EDL does not cover (speed ramps, stabilization, reframing with a moving crop, exporting stills, GIFs, extracting audio). Write outputs under edit/, never over the user's sources, then show_video the result.

## Sound
Few effects, each tied to something visible. No stock whoosh on every transition. Audio fades at every cut are automatic.

## Anti-patterns
Editing before the plan is approved · re-transcribing unchanged files · scanning whole videos with images · cutting by fixed seconds instead of words · linear easing in animations · unverified fonts · subtitles before overlays (the render already prevents this) · claiming how it sounds instead of reporting measurements.`

const MOTION = `# Motion graphics (motion_preview + motion_frame + motion_render)

A composition is a FOLDER, not a single file: an entry edit/animations/<slot>/index.html plus its dependencies sitting next to it (a local gsap.min.js, the fonts, the images). Everything loads by relative path — no CDN, no remote fetch: the render runs offline and a script that fails to load silently is a broken render.

## Contract: time is the whole FRAME, at 30 fps
- The composition implements window.orbitMotion.seek(frame) with an INTEGER frame (the runtime converts it to seconds: t = frame / fps) and every frame depends ONLY on the frame number. Frame 84 is a pure function of 84: same number in, same pixels out, every time — in this machine, in the next render, in a band that starts at frame 84. 30 fps is the default; declare another fps only when the piece really needs it.
- Why: the render splits the frames into parallel bands (one per core) and each band has to produce, on its own, exactly the frame it would produce inside the full run. A frame that depends on how many frames were drawn before it cannot survive that split — and the number of bands follows the MACHINE, so an impure composition renders differently on a 4-core laptop and on a 16-core desktop. Same file, two different videos.
- Never: setTimeout/setInterval, Date.now(), a requestAnimationFrame loop with its own clock, or any state that accumulates from one frame to the next (a counter, +=, Math.random() drawn once and reused). They make pass 1 differ from pass 2 — a frozen render, flicker, or a ghost of the previous frame.
- A composition that genuinely cannot be pure (it has to carry state between frames) is rendered sequentially: motion_render with bands: 1 does one pass, no split, no drift. Slower, but correct — say so instead of shipping a piece that flickers.
- window.orbitMotion offers: seek(frame) (your entry point), durationInFrames, width, height, fps, version, and the pair delayRender() / continueRender(handle).
- Loading something async (a font, an image, fetch)? Call delayRender() before it starts and continueRender(handle) with the returned handle when it settles. Without that pair the frame can be captured blank, before the asset exists.
- Everything is driven from the frame: inside seek, gsap timeline.seek(frame / fps, false), el.animate(...).currentTime, your canvas draw, video currentTime. GSAP, CSS and the Web Animations API are all fine — the point is that seek(frame) is what moves them, never a clock of your own.
- Declare the format: <meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=4"> (or window.orbitMotion = { width, height, fps, durationInFrames }, or pass them to the tool). 4 s at 30 fps = 120 frames — do the arithmetic to frames, never "about half a second".
- Size the page exactly to the declared width/height (html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden }). That is the composition's OWN document size, not a suggestion: the render opens the capture window at exactly this size, and the Motion tab scales the whole document down to fit the stage. Never make a composition adapt to the viewport (no vw/vh units, no %-based layout). If a preview ever looks cropped, off-centre or shifted, the fault is in the STAGE, not in the composition — report it to the user; do not rewrite the piece to please the preview.

## In chat mode (no working folder)
- The composition lives in Orbit's own storage, one folder per conversation, and is addressed by NAME: motion_write({ name, html }) creates or replaces it (and opens the Motion tab), motion_edit({ name, edits }) changes it with exact text replacements, motion_read({ name }) returns the current HTML, motion_frame({ name, times }) looks at instants, motion_render({ name }) makes the video only when asked.
- There is no folder to copy a library into, so there is no local gsap: animate with CSS @keyframes / transitions or the Web Animations API (both are seeked automatically), or drive everything from window.orbitMotion.seek(frame) yourself. Fonts: system fonts or a Google Fonts <link>.
- Everything else in this guide holds: declare the format, keep every frame a pure function of the frame number, name the parts with data-layer.

## Looking without eyes — the turns are lost here
You cannot see. motion_frame saves a contact sheet to edit/motion-frames/, and it goes to the USER, not to you: do NOT spend turns trying to see it yourself — no panel screenshots, no image_edit/describe_image on the sheet, no loop of panel_eval/run_browser_script over the composition to inspect pixels. What you read instead is the STRUCTURE: the data-layer tree (the Motion tab draws one track per layer, with the frames where it enters and leaves), what the calls return (msPerFrame, failedFonts, the cut points of a render) and — when a doubt is genuinely geometric (a width, an overlap, a centring) — ONE targeted measurement that answers it. Look, measure once, decide. The back-and-forth of transferring images to look at pixels is what makes a motion piece take forever, and it does not make the piece better.

## Transitions: orbitMotion.transition
Do not hand-write the swap between two scenes — declare it. The runtime turns it into paused animations that the seek already positions (so it is deterministic in the tab, in motion_frame and in the render), and it composes with the transform/opacity you already wrote:
  orbitMotion.transition({ out: '#scene1', in: '#scene2', at: 3, duration: 0.6, type: 'wipe', direction: 'left' })
- out/in are a selector or an element; give both for a swap, or ONE of them for an exit or an entrance alone. at is seconds on the piece (duration defaults to 0.6, easing to 'ease-in-out'; any CSS easing works).
- type: fade (crossfade) · push (both slide together) · cover (the incoming slides OVER a still scene) · reveal (the outgoing slides AWAY off a still scene) · wipe (a moving edge) · zoom (direction 'in'|'out') · blur (amount = px, default 24) · iris (a circle opening from the centre). direction is left/right/up/down, where the motion GOES; fade, blur and iris have no direction.
- Stacking: wipe works whatever the order; cover and iris need the incoming scene ABOVE the outgoing one, reveal needs the outgoing one above. Do not hide the incoming scene yourself (no opacity:0 or display:none in the CSS for it): the transition keeps it hidden until "at" and releases it afterwards.
- A bad type, direction or selector THROWS with the reason; the call reports the transitions it registered, and the motion_preview result lists them. Do not put two transitions on the same element at the same time (the lint warns).

## Video and GIF inside a composition
A <video> or a GIF <img> is an element like any other: copy the file next to index.html, reference it by relative path, and style it with CSS (position, size, transform, opacity, border-radius, filter). The runtime positions both on every frame, so they are deterministic like everything else.
- Timing, all optional and in seconds: data-start (when it begins ON THE PIECE; before that it holds its first frame), data-in (where in the FILE it begins — a cut at the start), data-end (when it stops, holding the last frame). Without them the file plays from the start of the piece. A <video loop> wraps; a GIF repeats by default and data-loop="false" holds its last frame.
- CROP: object-view-box: inset(top right bottom left) cuts the source itself (percentages or px) and the element scales what is left to its own box — object-view-box: inset(0 25% 0 25%) on a 16:9 video keeps the middle half. Combine with object-fit: cover and object-position to fill a box, with border-radius or clip-path for the shape. It is animatable, so a slow push-in or a pan is @keyframes over object-view-box (or a transform: scale() inside an overflow:hidden wrapper). The source file is untouched.
- SOUND: the page is silent in the capture, so the sound of a <video> is mixed by the render from the same attributes (data-start/data-in/data-end/loop) as a track of the piece — the tab plays it on its own row. A video that has an audio stream is heard unless you silence it: the muted attribute, or data-audio="false". Use data-gain="-6" (dB) to lower it under a voice-over. If you do not want the original sound (b-roll under a narration), put muted on it — do not leave it to chance.
- A hidden <video> still sounds if it is not muted. Give it data-start/data-end that match when it is on screen, or mute it.
- GIFs are decoded into whole frames before the first frame is drawn (the render waits for them), so keep them small: more than ~1500 frames is refused. A large GIF is better converted once with ffmpeg to an mp4/webm and used as a <video> (smaller, and it can have sound).
- ATTACHMENTS: a video, photo, GIF or audio the user attached is NOT in the composition folder and not in your context — you have a ref (vdo_…, img_…, aud_…) and a one-line description. Read it only when the request needs it (video_probe for details, video_transcribe for what is said, video_timeline for a window of frames), and when you decide to USE it in the piece, call motion_asset({ ref, name }) (chat mode) or motion_asset({ ref, path }) (code mode, the composition folder): it copies the file next to index.html and tells you the file name and how to use it. Do not copy attachments you will not use, and do not transcribe or look at a video just because it was attached.
- To prepare the file first (trim a long clip, extract a section, scale it down, convert a GIF) use the bash tool with ffmpeg and write the result into the composition folder — the EDL tools cut and join whole videos, they are not part of a composition.

## Assets: images, fonts and audio
- Images, SVG, video and fonts: copy the file next to index.html and reference it by RELATIVE path (the orbit-motion:// scheme serves it; no CDN, no network). Wrap the load in delayRender()/continueRender() while it decodes, or the frame is captured before the asset exists.
- AUDIO: the capture takes frames, not sound (the window is offscreen and ffmpeg is fed rawvideo on stdin), so the sound is mixed in a FINAL pass with the video NOT re-encoded. Three ways in, and all of them land on the same files the tab plays:
  - audio.json in the composition folder — the manifest, for a piece with more than one track. Put the audio files next to index.html and declare them:
    { "tracks": [ { "file": "narracao.mp3", "name": "Narration" }, { "file": "musica.mp3", "gain": -18, "fadeOut": 1.5, "duck": true }, { "file": "whoosh.wav", "start": 4.2, "gain": -6 } ] }
    Only "file" is required. start/end are SECONDS on the piece (when the track enters and leaves); gain is dB; fadeIn/fadeOut are seconds; duck: true makes the track step back on its own while the others are playing — that is the music bed under the voice. Each track gets its own row in the Motion tab, drawn where it plays, so the user can see the bed and the effect and the narration at once.
  - TREATMENT, per track, in the same manifest — all optional, all applied by the render (the tab plays the raw file, so judge the result in the render, not in the tab): "preset": "voice" | "bed" | "phone" (a starting point; any field you write wins over it), "highpass": Hz, "lowpass": Hz, "eq": [{ "freq": Hz, "gain": dB, "q": 0.1–10 }] (up to 6 bands), "compress": true or { "threshold": dB, "ratio", "attack": ms, "release": ms, "makeup": dB }, "automation": [{ "at": seconds on the PIECE, "db": level }] (a volume curve, straight lines between points — a swell, a dip under a line), and duck can be { "threshold": dB, "ratio", "attack": s, "release": s } instead of true. A narration is usually { "preset": "voice" }; the music under it { "preset": "bed", "duck": true, "gain": -14 }.
  - FINISH the whole mix: the manifest can be an object with "master": { "limit": dB peak ceiling (e.g. -1), "loudness": LUFS delivery level (-16 voice, -14 music) } next to "tracks". Use limit whenever a track is boosted.
  - a single loose file named audio.mp3 (.wav/.m4a/.aac/.ogg/.opus/.flac) — one track, the whole piece;
  - or pass it explicitly for a one-off: motion_render({ path, output, audio: "edit/renders/voz.mp3" }).
- VOICE-OVER with the native TTS: write the lines, call audio_generate with the text EXACTLY as it should be spoken (no Markdown, no lists, numbers spelled out) and a savePath inside the composition folder (so the tab plays it too), then declare that file in audio.json. Write the composition to fit the voice.
- The COMPOSITION sets the length: a track running past the end is cut there, one that ends early leaves the rest to the others. The render WARNS when a track overflows the piece — read that warning instead of guessing. The <audio> element in the page is not part of the capture and does not reach the video; the sound of a <video> does (see "Video and GIF inside a composition").

## The lint — read it
motion_preview / motion_write / motion_edit end with a "Lint:" block, and motion_render adds the same findings to its warnings. It is read from the text of the composition and from what the page registered, before any render: wall clock (Date.now/performance.now), Math.random, setInterval, CSS transitions, infinite loops, vw/vh units, files that do not exist next to index.html (or sit outside the folder), network resources, an <audio> in the page, transitions that fall outside the piece, audio tracks that never play, fades longer than the track, and boosts with no limiter. [error] means the piece will come out wrong — fix it before anything else; [warning] is a suspicion, usually worth a look. "Lint: clean." means nothing to fix; it does not mean the piece is good.

## Name the elements
- Give every element that makes up the scene a data-layer="name" (<div class="ring" data-layer="ring">). Optional, but recommended: it is what lets the piece be cited by name later ("the ring layer enters late", "the title is 6 frames behind the voice"), and it is cheap now and expensive to add afterwards.

## Workflow (write → open → look → iterate → approval → render)
1. Write the composition folder.
2. motion_preview({ path: "edit/animations/<slot>/index.html" }) — registers the composition folder and opens the Motion tab in the panel so the user can watch it (the tab has play/pause and a slider; it serves the same runtime the render uses, so what the user sees there is what the render produces).
3. Look at 3–5 key instants with motion_frame({ path, times: [0, 0.6, 1.8, 3.4] }) — times in SECONDS. This is the cheap look: a few frames in front of you, no video file, no encode. Cover the entrance, each element landing, the payoff and the hold at the end. An instant that comes out blank is information too.
4. Iterate: edit the file; the tab reloads and comes back to the same instant, so you compare the same frame before and after your change — and the next motion_frame looks at the same instants again.
5. Ask the user to look at it in the panel and say what to change. Their notes can arrive pinned to a frame ("Frame 69 … Selected layer: title … On screen: …") — edit exactly that moment and that element.
6. The video file is NOT part of this loop. The user renders from the Render button of the Motion tab when they are happy. Call motion_render only when they explicitly ask YOU for the file (or you need the clip as an overlay in an EDL), and never post the render in the chat unless asked — the tab is where they watch it.
- Keep the composition folder clean: it is watched for live reload. Renders go to edit/renders/, contact sheets to edit/motion-frames/ (motion_frame does it) — never PNG checks, videos or scratch files next to index.html.
- Name what matters with data-layer: the Motion tab draws one track per layer with the frames where it enters and leaves. Unnamed elements that appear and disappear show up with their text; naming the phrases/elements makes those tracks (and the user's notes) readable.

## Render (motion_render) — the expensive step
- It captures and encodes every frame once. Run it after the approval, never to discover what the piece looks like.
- format: "mp4" (h264, no alpha — the normal clip), "mov-alpha" (ProRes 4444) or "webm-alpha" (VP9, smaller) for an overlay that has to sit over the footage. For alpha keep html/body background transparent.
- bands: how many parallel bands the frame range is split into; the default follows the cores. bands: 1 forces a single sequential pass — the escape hatch for a composition that cannot be pure.
- The result reports the time per frame (msPerFrame). A high number on a simple piece means the composition is doing per-frame work it could do once (a filter, a layout, a big image redrawn every frame): fix that before rendering again instead of paying for it twice.

## When NOT to use motion
- The app's own runtime above is the default and covers almost everything: titles, lower thirds, one-off motion graphics, an overlay for the EDL. Plain HTML/CSS/GSAP, no build, no npm, no network — and the Motion tab previews the plain HTML, so there is no build step between your edit and what the user sees.
- Remotion is NOT bundled: it is a dependency of the USER's project, not of Orbit — npm i remotion @remotion/cli react react-dom, a React build step, and a license (free for individuals and small companies, paid for larger ones — remotion.pro). Do not reach for it just to avoid writing CSS. Set it up when the user asks for it, when the project is already Remotion, or when the video is data/component driven (many variants from props).
- A Remotion composition does NOT open in the Motion tab: motion_preview only knows the app's own runtime. Its preview is the Browser tab with npx remotion studio, and the final render is npx remotion render — see video_guide("remotion").

## Craft
- Ease out/in-out (power2/power3, cubic-bezier) — never linear for UI or type motion.
- Sync the payoff: land the key word/number on the frame the narrator says it (take the word time from the transcript, convert it to the overlay's local frame: (word time − overlay start) × 30).
- Hold the final frame ≥ 30 frames (1 s) before an overlay ends; an entrance runs 9–18 frames (300–600 ms).
- Text must be readable on a phone: large, high contrast, short.
- Fonts: load them from local files with @font-face; motion_render warns when a font failed (the fallback is silent otherwise).
- After the user approved it and you rendered the clip, check it with video_timeline at the key moments before placing it in the EDL.
- Several independent animations? Delegate each to a sub-agent in parallel (subagent tool) with a self-contained brief: folder path, size/fps/durationInFrames, exact text, the payoff frame, palette, mp4 or alpha.

## Minimal skeleton
edit/animations/title/index.html (gsap.min.js copied next to it)
<!doctype html><html><head>
<meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=4">
<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:transparent}
.t{position:absolute;left:120px;bottom:160px;font:800 96px/1 Inter,Arial,sans-serif;color:#fff}</style>
<script src="gsap.min.js"></script></head><body><div class="t" data-layer="title">Ship faster.</div>
<script>
const tl = gsap.timeline({ paused: true })
tl.from('[data-layer="title"]', { y: 60, opacity: 0, duration: 0.5, ease: 'power3.out' })
  .to('[data-layer="title"]', { opacity: 0, duration: 0.4, ease: 'power2.in' }, 3.4)
window.orbitMotion = {
  width: 1920, height: 1080, fps: 30, durationInFrames: 120,
  seek(frame) { tl.seek(frame / 30, false) },
}
</script></body></html>`

const REMOTION = `# Remotion (React video) — when the user wants it

Remotion is NOT bundled with Orbit. It is NOT the default: for a one-off motion graphic (a title, a lower third, an overlay for the EDL) use the app's own runtime instead — plain HTML/CSS/GSAP, no npm, no build (video_guide("motion")). Remotion adds an npm install (remotion @remotion/cli react react-dom) and a React build step, and needs a license: free for individuals, non-profits and companies with up to 3 employees, paid for larger ones (remotion.pro) — tell the user this once before setting it up for a company project. Use it when the user asks for it, the project is already Remotion, or the video is data/component driven (many variants from props). The preview is different too: the user watches it in the BROWSER tab (npx remotion studio), not in the Motion tab — motion_preview only knows the app's own runtime.

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
