/**
 * The craft guide of video editing, for the MODEL (hence in English).
 *
 * It stays out of the system prompt: it is ~2k tokens that are only worth it when there is video in
 * the conversation. The prompt carries only one paragraph (VIDEO_INSTRUCTION in prompts.ts)
 * telling it to call `video_guide` before the first cut. Based on the production
 * rules of video-use (browser-use), adapted to Orbit's tools — what over there
 * was a rule for the model to remember, here the render already does on its own.
 */

const EDITING = `# Video editing — workflow and craft

## Principle
You READ footage, you don't watch it. The word-timed transcript (transcribe) is your main view; video_timeline images are for decision points only. Decisions go into an EDL; video_render applies them deterministically. The SAME transcript carries the exact time of every word — that is where subtitle, caption and overlay timing comes from, never from an estimate.

## Workflow (ask → confirm → execute → self-check → persist)
1. Inventory: video_probe every source; transcribe all of them in one call (ids A, B, C… or take1…, detail "phrases"). Look at 2–3 video_timeline windows to know what the footage looks like (framing, light, b-roll vs talking head).
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

## Subtitles and cue timing
A cue is one block of text with a start and an end. Its times come from the WORDS, never from a guess:
- transcribe({ sources, detail: "words" }) gives every word with its own start and end (the same data is cached in edit/transcripts/<file>.json). Splitting a clip's duration by character count — or by "that sounds like half" — is what puts a subtitle 0.6 s ahead of the voice.
- The safe default is ONE CUE PER SPOKEN CLIP: a clip of 1–4 s is in sync by construction, because the cue starts and ends exactly with the audio. When one clip carries two sentences, split at the punctuation, using the word time of the first word after it.
- To CHECK sync you do not render: compare the cue times against the word times and against the moment of the action on screen. A render is for what only a render shows (a cut, an overlay, a burned subtitle).
- Two ways to produce subtitles, and the choice is about EDITING COST: burned into the video (ffmpeg .ass/.srt — fast, deterministic, fixed forever, right for a final delivery) or drawn by the composition/player (editable, animatable, one line changed instead of a re-encode — the default for a motion piece). Decide before building; converting later pays the expensive step again.

## Narration (TTS) and recording a demo
- ONE CLIP PER SCENE, not one per video: each scene's narration is its own audio_generate call, so it can be placed, re-timed, re-recorded or replaced on its own — a single 60 s file has to be regenerated whole when one sentence changes.
- YouTube pacing: a YouTube narrator speaks fast. Settle the SPEED on the first segment (1.1–1.2 is the usual landing zone), check it, then generate every other segment with the SAME speed and voice — a narrator who changes pace between scenes sounds broken.
- Narration that must land on UI actions: generate and MEASURE the clips first, then place them (and perform or record the actions) against that timeline. The other order forces every scene to be redone.
- RECORDING AN APP (browser_record or any screencast): ASK the user first — clean (fresh session, no caches, no leftover tabs, nothing private on screen) or exactly as it is now? A take is expensive to redo. Before recording, also clear what the app restores by itself (localStorage, previous tabs): a leftover tab with old text in it is how a whole take becomes unusable.

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

## In chat mode and with attachments (no working folder)
- A video the user attached is not a file in a folder: it is a ref (vdo_…) and a one-line description. Use the ref wherever the workflow says "path": video_probe, transcribe, video_timeline and the EDL sources (and overlay / music / subtitle files — img_…, aud_…) all accept it. Nothing needs to be copied first.
- Chat mode has no edit/ folder and no bash: video_render writes the result to the app (the user sees it as a player in your reply and in the Media tab, where they can delete it and free the space). Every final render is its own item; the preview is one file that each new preview replaces. Do not offer to "save into the project".
- In code mode a ref also works as a source, but the output goes to edit/ of the project (it is the user's file). Use motion_asset only to put the file INSIDE a motion composition.
- The workflow is the same: inventory with video_probe/transcribe, propose, wait for approval, preview, self-check, final.

## Beyond the EDL
The bash tool has ffmpeg and ffprobe (the app ships them). Use them for what the EDL does not cover (speed ramps, stabilization, reframing with a moving crop, exporting stills, GIFs, extracting audio). Write outputs under edit/, never over the user's sources, then show_video the result.

## Sound
Few effects, each tied to something visible. No stock whoosh on every transition. Audio fades at every cut are automatic.

## Anti-patterns
Editing before the plan is approved · re-transcribing unchanged files · scanning whole videos with images · cutting by fixed seconds instead of words · linear easing in animations · unverified fonts · subtitles before overlays (the render already prevents this) · claiming how it sounds instead of reporting measurements.`

const MOTION = `# Motion graphics (motion_write + motion_edit + motion_frame + motion_render)

Three companion guides: video_guide("motion-style") (the user gives a reference video or says "like this one" — read the reference and write a style brief first), video_guide("motion-craft") (direction: shot list, easing, layers, sound — read it before the FIRST composition) and video_guide("motion-3d") (three.js — read it before any 3D, WebGL or canvas piece).

A composition is an Orbit piece: a FOLDER in Orbit's own storage (never in the user's project), with an index.html entry plus its dependencies sitting next to it (the images, the clips, the fonts, a local gsap.min.js). It is addressed by NAME in every motion tool — the same tools in chat and in code mode. Everything loads by relative path — no CDN, no remote fetch: the render runs offline and a script that fails to load silently is a broken render.

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

## The tools (both modes)
- motion_write({ name, html }) creates or replaces the composition and opens the Motion tab; motion_edit({ name, edits }) changes it with exact text replacements; motion_read({ name }) returns the current HTML behind a header with its hash (for a big file pass symbol: "buildK" — a function, class, const or CSS rule by name, returned whole —, from/to, or find with one text or several, instead of re-reading it all); motion_edit answers with a RECEIPT — the line where each edit landed, what is there now, the hash before → after: if the receipt does not show your change it did not land, so never assume; motion_preview({ name }) reopens it (and reports layers and lint) when the tab was closed; motion_frame({ name, times, probe, audio }) looks at instants — probe: ['.w3', '[data-layer=title]'] reads those elements as NUMBERS at each instant (opacity, scale/move, box, inside the frame) evaluate: ["p.on", "words.length"] reads JS EXPRESSIONS from the running page after each seek (globals only — expose a variable as window.name; a value deduced from opacities is better read directly), and audio: true MEASURES the sound there (dBFS of the mix as the render builds it, and of each track alone): use them to answer a numeric doubt instead of loading an image or reasoning a mix in the dark; motion_render({ name }) makes the video only when asked; motion_delete({ name }) removes it when the user asks. A piece from another conversation is reached by its id (mv_…) instead of the name.
- Never write the composition with write/edit/bash, and never put it in the project: every change through these tools is what keeps the piece in the Media gallery and lets the user undo the message.
- Bringing material in: motion_asset copies a file into the composition folder — an attachment by its ref, or (code mode) a file of the working folder by path. A library is the same: motion_asset({ name, path: "node_modules/gsap/dist/gsap.min.js" }) when the project has it. three.js needs no motion_asset: it is native (import * as THREE from 'three' in a module script — see video_guide("motion-3d")). With no local copy there is no gsap: animate with CSS @keyframes / transitions or the Web Animations API (both are seeked automatically), or drive everything from window.orbitMotion.seek(frame) yourself. Fonts: system fonts or a Google Fonts <link>.

## Looking without eyes — the turns are lost here
Looking is the exception (for a 3D piece the rule relaxes: one contact sheet per shot, see video_guide("motion-3d")). motion_frame saves a contact sheet for the USER and, by default, does not load it into your context (see: true does, for ONE genuinely visual doubt): do NOT spend turns trying to see the piece — no panel screenshots, no image_edit/describe_image on the sheet, no loop of panel_eval/run_browser_script over the composition to inspect pixels. What you read instead is the STRUCTURE: the data-layer tree (the Motion tab draws one track per layer, with the frames where it enters and leaves), what the calls return (msPerFrame, failedFonts, the cut points of a render) and — when a doubt is genuinely geometric (a width, an overlap, a centring) — ONE targeted measurement that answers it. Look, measure once, decide. The back-and-forth of transferring images to look at pixels is what makes a motion piece take forever, and it does not make the piece better.

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
- FINDING IMAGES: when the piece needs a photo you do not have (animals, places, objects, history), image_search looks on Wikimedia Commons and Openverse and shows a numbered sheet of thumbnails — choose by looking, search in English, try a second query if the first is poor. image_import brings the chosen ones in as refs (img_…) WITH their author and license, then motion_asset puts them in the composition. Only openly licensed images are used (license "commercial" by default). The license usually requires a CREDIT: motion_asset tells you the exact line, and the piece must show it — a small caption on the image, or a credits card at the end listing every image (title, author, license). Never present a found image as your own or drop its credit.
- ATTACHMENTS: a video, photo, GIF or audio the user attached is NOT in the composition folder and not in your context — you have a ref (vdo_…, img_…, aud_…) and a one-line description. Read it only when the request needs it (video_probe for details, transcribe for what is said, video_timeline for a window of frames), and when you decide to USE it in the piece, call motion_asset({ name, ref }): it copies the file next to index.html and tells you the file name and how to use it. In code mode a file of the working folder comes in the same way with motion_asset({ name, path }). Do not copy material you will not use, and do not transcribe or look at a video just because it was attached.
- To prepare a file first (trim a long clip, extract a section, scale it down, convert a GIF) — code mode — use the bash tool with ffmpeg, write the result under edit/ in the working folder and bring it in with motion_asset({ name, path }). The EDL tools cut and join whole videos; they are not part of a composition.

## Assets: images, fonts and audio
- Images, SVG, video and fonts: copy the file next to index.html and reference it by RELATIVE path (the orbit-motion:// scheme serves it; no CDN, no network). Wrap the load in delayRender()/continueRender() while it decodes, or the frame is captured before the asset exists.
- AUDIO: the capture takes frames, not sound (the window is offscreen and ffmpeg is fed rawvideo on stdin), so the sound is mixed in a FINAL pass with the video NOT re-encoded. Three ways in, and all of them land on the same files the tab plays:
  - audio.json in the composition folder — the manifest, for a piece with more than one track. Put the audio files next to index.html and declare them:
    { "tracks": [ { "file": "narracao.mp3", "name": "Narration" }, { "file": "musica.mp3", "gain": -18, "fadeOut": 1.5, "duck": true }, { "file": "whoosh.wav", "start": 4.2, "gain": -6 } ] }
    Only "file" is required. start/end are SECONDS on the piece (when the track enters and leaves); offset is the second OF THE FILE where the sound begins (start a song at its chorus: { "file": "song.mp3", "start": 0, "offset": 62.5 }); loop: true repeats the file until end. LEVEL: gain is in dB (0 = as it is, -18 = a quiet bed) — "gain": 0.15 is NOT 15%, it is full volume; for a fraction use "volume" (linear: 1 = as it is, 0.15 = quiet), never both. fadeIn/fadeOut are seconds; duck: true makes the track step back on its own while the others are playing — that is the music bed under the voice. Each track gets its own row in the Motion tab, drawn where it plays, so the user can see the bed and the effect and the narration at once.
    ONE SONG = ONE TRACK. Every entry plays its file from the start (or from its offset): splitting a song into one entry per scene restarts it at 0:00 on every scene. A continuous song is a single track; its level changes over the piece with "automation" ([{ "at": 0, "db": 0 }, { "at": 8, "db": -18 }, …]) or by itself with "duck": true under the narration.
  - TREATMENT, per track, in the same manifest — all optional, all applied by the render (the tab plays the raw file, so judge the result in the render, not in the tab): "preset": "voice" | "bed" | "phone" (a starting point; any field you write wins over it), "highpass": Hz, "lowpass": Hz, "eq": [{ "freq": Hz, "gain": dB, "q": 0.1–10 }] (up to 6 bands), "compress": true or { "threshold": dB, "ratio", "attack": ms, "release": ms, "makeup": dB }, "automation": [{ "at": seconds on the PIECE, "db": level }] (a volume curve, straight lines between points — a swell, a dip under a line), and duck can be { "threshold": dB, "ratio", "attack": s, "release": s } instead of true. A narration is usually { "preset": "voice" }; the music under it { "preset": "bed", "duck": true, "gain": -14 }.
  - FINISH the whole mix: the manifest can be an object with "master": { "limit": dB peak ceiling (e.g. -1), "loudness": LUFS delivery level (-16 voice, -14 music) } next to "tracks". Use limit whenever a track is boosted.
  - a single loose file named audio.mp3 (.wav/.m4a/.aac/.ogg/.opus/.flac) — one track, the whole piece;
  - or, in code mode, pass a file of the working folder for a one-off: motion_render({ name, audio: "edit/voz.mp3" }) — it plays from the start, and the tab does not hear it.
- VOICE-OVER with the native TTS: write the lines, call audio_generate with the text EXACTLY as it should be spoken (no Markdown, no lists, numbers spelled out) and timings: true, bring the file into the composition with motion_asset (its aud_… ref, or in code mode its savePath) so the tab plays it too, then declare it in audio.json. The NARRATION sets the scene: the result gives its exact duration — the scene lasts that plus a short breath, never a window planned before the voice existed (a 24 s narration in a 60 s scene is 36 s of dead air). Captions come from the caption lines it returns (real start/end in that audio; add the track's start on the piece) — never space captions evenly or by a guessed rate.
- ON THE BEAT: the beat times of a song come from audio_bpm({ path, fps: the piece fps }) — bpm, confidence and the beat list in seconds. Pulses, cuts and letter pops snap to those times (frame = round(second × fps)), never to a typed bpm. For a pulse that follows loudness rather than the grid use orbitMotion.audio.level/bands.
- SOUND EFFECTS (whoosh, hit, pop, bell, riser, glitch, tick): the user's own file wins; otherwise sfx_generate({ kind }) synthesises one (no licence to credit) and gives a ref for motion_asset. Order of choice: an attached sound, then sfx_generate, and only search the web if the user asks (and then only openly licensed, with the credit shown). A few effects, each tied to something visible: a whoosh on a camera move or a wipe (start its track the seconds the result says BEFORE the move ends, so the swell lands with it), a hit on the impact or the cut on the beat, a pop per letter only if the pace is slow, a riser before a payoff. Put them in audio.json a few dB under the music (gain -8 to -14) and under the voice (-16 to -20), with master limit set; never one on every transition. Check the mix with motion_frame audio: true.
- SONG LYRICS on screen: the times come from transcribe({ sources: [the song], detail: "words" }) (music makes the engine less sure — check the words against the known lyrics and keep the times). Never time lyrics at a fixed rate per word.
- The COMPOSITION sets the length: a track running past the end is cut there, one that ends early leaves the rest to the others. The render WARNS when a track overflows the piece — read that warning instead of guessing. The <audio> element in the page is not part of the capture and does not reach the video; the sound of a <video> does (see "Video and GIF inside a composition").

## Animation helpers (Remotion-style, built in)
Every composition has these on window.orbitMotion — pure functions of the frame, the same in the tab, motion_frame and the render. Use them instead of hand-written if/else on the frame (a value that jumps from 0 to 1 on one frame is a hard cut, the mark of an amateur piece):
- interpolate(frame, [0, 20], [0, 1], { easing }) — maps a frame range to values; several points make a fade in–hold–fade out: interpolate(frame, [0, 10, 80, 90], [0, 1, 1, 0]). CLAMPS at both ends by default ({ extrapolateRight: 'extend' } to keep going).
- spring({ frame, from: 0, to: 1, damping: 10, stiffness: 100, mass: 1, delay: 0 }) — a natural settle with a little overshoot (damping 20+ for none); fps comes from the piece.
- Easing.easeOut / easeIn / easeInOut, Easing.out(Easing.cubic), Easing.bezier(0.2, 0.8, 0.2, 1), Easing.back(1.7), Easing.elastic(1).
- sequence(frame, from, durationInFrames) → { active, frame, progress }: a scene's LOCAL frame (0 at its start), so each scene animates from 0 and can be moved by changing one number.
Typical script-driven piece:
  const M = window.orbitMotion
  M.seek = (frame) => {
    const s1 = M.sequence(frame, 0, 90)
    title.style.opacity = M.interpolate(s1.frame, [0, 12, 78, 90], [0, 1, 1, 0])
    title.style.transform = 'translateY(' + M.interpolate(s1.frame, [0, 18], [40, 0], { easing: M.Easing.easeOut }) + 'px)'
    card.style.transform = 'scale(' + M.spring({ frame: s1.frame, delay: 10 }) + ')'
  }
Stagger a list by giving each item its own delay (frame - i * 4). Words that appear one by one: an opacity/transform per word from interpolate — and check with motion_frame that they are really visible.

## Text that must fit, and randomness: orbitMotion.fitText / measureText / random
- fitText(textOrElement, { maxWidth: 952, maxLines: 1, maxHeight, min: 8, max: 600 }) → { fontSize, lines, width, height, fits } — the LARGEST size at which the text stays inside the box, measured in the page with the real font. "EQUILIBRIO at 104 px in 952 px?" is a call, not a guess: const { fontSize } = M.fitText('EQUILÍBRIO', { maxWidth: 952, fontWeight: 800, fontFamily: 'Inter' }). Pass the style (fontFamily, fontWeight, letterSpacing, textTransform, lineHeight) or an element to copy it from. fits: false means not even min fits — shorten the text or widen the box.
- measureText(textOrElement, { fontSize, maxWidth, …style }) → { width, height, lines, overflowX } for a size you already chose. Without maxWidth it is one line at its natural width.
- Call them once at the start, after the fonts are in (document.fonts.ready) — the answer depends on the font that rendered. They only read; nothing moves between seeks.
- random(seed) → [0, 1), the same number for the same seed in every frame and render: M.random('p' + i + ':x') for the x of particle i. Never Math.random (the lint refuses it).

## Scenes: write DURATIONS, never start times
A piece of several scenes with a start time typed on each (and again in audio.json) breaks the moment one scene changes: cutting 10 s from the middle means retyping every number after it, and the one you forget misaligns everything without an error. Declare the durations and let the sum place them:
  const M = window.orbitMotion
  const S = M.scenes([
    { name: 'intro', dur: 4 },                    // seconds
    { name: 'verse', dur: 20, overlap: 0.5 },     // starts 0.5 s before intro ends (crossfade)
    { name: 'payoff', dur: 3, gap: 0.4 },         // 0.4 s of nothing before it
  ])
  M.seek = (frame) => {
    const t = frame / M.fps
    const v = S.local('verse', t)                  // { active, t: seconds into the scene, progress 0..1 }
    verse.style.opacity = v.active ? M.interpolate(v.t, [0, 0.4], [0, 1]) : 0
  }
- S.verse.start / S.get('verse').end / S.total are seconds on the piece clock; S.at(t) is the scene on screen (the incoming one during an overlap). A scene called "list", "total", "get", "at" or "local" is reached only through S.get(name).
- With <meta name="orbit-motion" content="width=1080,height=1920,fps=30,duration=auto"> (or no duration at all) the SUM of the scenes is the length of the piece — nothing else to keep in step. A fixed duration in the meta still works; the lint then says if the scenes are cut off by it or leave a tail.
- A scene as long as its narration (the length follows the voice, never the other way): wait for the word times, then lay the scenes out —
    let S = null
    const hold = M.delayRender()
    M.audio.ready().then(() => {
      const v = M.audio.span('nar-s01.wav')            // { start, end } of the voice, piece seconds (null without word times)
      S = M.scenes([{ name: 's1', dur: v.end + 1.2 }, /* … */])
      M.continueRender(hold)
    })
    M.seek = (frame) => { if (!S) return; /* … */ }
- To retime later: motion_edit the ONE dur (or gap/overlap); audio.json tracks that belong to a scene change their "start" by the same amount — read S.get(name).start from the motion_preview report ("Scenes: …") to know the new value.

## Camera: build a WORLD, then move the camera through it
The look of a kinetic-type piece or an app tour is rarely a cut between scenes: it is ONE flat world and a camera that zooms into an object until it fills the frame, flies past layers (parallax), snaps to the next spot like a slingshot, or pulls back to show that what looked like a background was an object. Do not fake it with a different animation per element: put everything in a world and move the camera.
  <div id="world">                      <!-- the element whose DIRECT children are the layers -->
    <div class="layer">…the near stuff…</div>
    <div class="layer" data-depth="2">…farther: moves half as much…</div>   <!-- data-depth 0.5 = nearer, moves double -->
  </div>
  const cam = orbitMotion.camera({ world: '#world' })      // start: { x, y, zoom, rot } (default: centre, 1, 0)
  cam.focus('#price', { at: 1, dur: 0.8, padding: 80 })    // frame an element (fit 'contain'); { rect: {x,y,w,h} } to give it by hand
     .move({ at: 3, dur: 0.9, style: 'slingshot', to: { x: 1600, y: 400, zoom: 2 } })   // a move only says what changes
     .zoomThrough('#ring', { at: 5, dur: 0.7 })            // flies INTO the element until it fills the frame
     .shake({ at: 5.7, dur: 0.4, amp: 18 })                // an impact; amp in world px
- Positions are WORLD pixels (x, y = the point at the centre of the frame), times are SECONDS, zoom 1 = natural size. Moves are in order and cannot overlap (the error says which); between moves the camera holds.
- style: 'ease' (calm default, in-out) · 'push' (accelerates toward the lens: the lunge before an impact or a zoom-through) · 'pull' (fast, then settles: a pull-back) · 'slingshot' (winds up the OTHER way, launches, overshoots, settles: the move between two spots of an app) · 'whip' (holds, snaps, stops: a fast pan) · 'linear'. slingshot takes back (0.12 = wind-up as a fraction of the travel) and overshoot (1.2).
- ZOOM-THROUGH (match cut): give the object the colour/texture of the next scene's background. The camera flies into it (zoomThrough), it fills the frame, and from there the next scene is already "behind": show the next layers and pull back ({ style: 'pull', to: { zoom: 1 } }) and the object is revealed inside its new context. Hide layers with opacity or visibility, NEVER display:none (focus cannot measure an element with no box).
- FOR AN APP: focus the card, hold for the line of narration, slingshot to the next panel. One focus per idea; a hold of 0.6–1 s after each move.
- Fake depth: parallax (data-depth) + a zoom that accelerates is enough; there is no real 3D here. For real 3D use three.js (video_guide("motion-3d")).
- The camera OWNS the transform of the world's direct children: animate what is inside them (a wrapper), never the layer itself. It runs after your seek, so it is a pure function of the frame like the rest. Read it with motion_frame evaluate: ["cam.at(2.5)"] (expose it as window.cam).
- Do not fake a camera move with a CSS transition or a blur on the whole frame: the lint refuses the first and the second is a render trap.

## Props: ONE piece, MANY videos
When the same piece has to come out many times with other data (a title, a price, a name, a colour, a logo — an offer per product, a card per person), do NOT copy the piece and edit its text: declare the parts that change and render it with other values.
  props.json (next to index.html; write it with motion_write files):
    { "title": { "type": "text", "default": "Black Friday" },
      "price": { "type": "number", "default": 99, "min": 0 },
      "color": { "type": "color", "default": "#c93b64" },
      "tone":  { "type": "select", "options": ["warm", "cool"], "default": "warm" },
      "logo":  { "type": "image", "default": "logo.png" },
      "badge": "NEW" }                      <!-- shorthand: a bare value is its own default (text, number, true/false or #colour) -->
  in the page:   const { title, price, color } = orbitMotion.props     // fixed for the whole render: a frame stays a function of its number
  one render:    motion_render({ name, props: { title: "Oferta A", price: 49 } })       // the rest keep their defaults
  in bulk:       motion_render({ name, variations: [{ name: "oferta-a", props: {...} }, { name: "oferta-b", props: {...} }] })   // up to 50, one file each
- Types: text, number (min, max), color (#hex), boolean, select (options), image (a path inside the piece folder: put the file there with motion_asset first). An undeclared name or a wrong type is refused with the list of what IS declared, and every variation is checked BEFORE the first frame.
- Design the piece for the data it will get: size text with fitText (a long name must fit), never hard-code a value that is also a prop, and give each prop a default that makes a good video by itself (the preview and a render without props use them).
- A prop that changes the LENGTH (a longer name, more items) must not change the declared duration silently: derive scenes from durations (orbitMotion.scenes with duration=auto) and test the longest case with motion_frame({ props: { … } }).
- The lint says when the page reads a prop that props.json does not declare (error) or declares one the page never reads (warning). motion_preview lists the declared props.
- For many items from a list the user gave you, build the variations array from it (one name per item); render a first variation alone and look at it before launching fifty.

## Sound-reactive visuals: orbitMotion.audio
A waveform, an equalizer or a pulse must come from the REAL sound — never Math.sin or random bars. The runtime analyses the tracks of audio.json (placed on the piece timeline with their start/offset/end/level) once, and then reads them by frame:
- orbitMotion.audio.load() at the top of the script (seeks wait for the analysis); load('song.mp3') analyses one track alone.
- orbitMotion.audio.level(frame) → 0..1 loudness (1 = loudest moment of the piece) — a pulse, a glow, a scale.
- orbitMotion.audio.bands(frame, 24) → 24 values 0..1, low to high frequencies — the bars of a spectrum/waveform. Pass the track as the last argument to follow only the music under a voice: bands(frame, 24, 'song.mp3').
Smooth a jumpy bar by averaging with the frames around it (bands(frame - 1) and bands(frame + 1)), never with state kept between seeks.

## Text in sync with the voice (karaoke, lyrics, captions per word)
The pain of this kind of piece is the TIME of each word. It never comes from your arithmetic — not by hand, not by dividing a line by the length of its words (that puts the red on the wrong syllable) — it comes from the audio:
1. Narration: audio_generate({ text, timings: true }). It prints caption lines, saves the time of EVERY word with the audio and warns when the voice did not say what you wrote ("PRIDE" read as another word: write it as it should sound, lowercase or spelled out, and generate that phrase again). A sung line or a narration that came without timings: motion_asset({ ref, words: true }).
2. motion_asset(ref) copies the audio and its word times (nar.wav + nar.wav.words.json); declare the track in audio.json with its "start".
3. In the script, call orbitMotion.audio.load() at the top, then read the words ALREADY on the piece clock (track start and offset applied, so moving the track in audio.json moves the words with it):
  - audio.words('nar.wav') → [{ text, start, end }] in seconds (no argument = every track).
  - audio.lines('nar.wav', { maxWords: 7, pause: 0.35 }) → [{ start, end, text, words }]: one caption/line each.
  - audio.wordAt(t) → index of the word being spoken at t (-1 before the first); audio.find('humilde', { after: 56 }) → when it is spoken (-1 if never) — use it for the keyword that turns red instead of computing it.
  Karaoke: lines.forEach(line => line.words.forEach(w => word.classList.toggle('on', t >= w.start))). Show a word ~0.5 s BEFORE it is sung (t >= w.start - 0.5) and a phrase before its first word; hold the last one past its end.
4. The duration of each block is the narration plus a visual tail, never the other way. Check with motion_frame at the moment of a keyword: the "On screen" line must show it lit.
Check the words against the script you know (music makes the engine less sure) and keep what the engine measured; fix the SPELLING in your own text, not the times.

## Subtitles and text that will change: keep them in the piece
- A motion piece gets its subtitles INSIDE the composition by default — a DOM layer driven by seek — and not burned into a video beforehand. A line edited afterwards is then an exact text edit that the tab reloads in a second; burned-in text costs a full re-render for a comma.
- Burn them into the file only when the user asks for it: a clip that will be reused elsewhere, or an overlay for the EDL.
- The same reasoning covers anything the user will want to tweak — captions, names, prices, credits. Text stays editable; pixels do not.
- The times for those cues still come from transcribe({ detail: "words" }) — the rule is in video_guide("editing"), "Subtitles and cue timing".

## The lint — read it
motion_preview / motion_write / motion_edit end with a "Lint:" block, and motion_render adds the same findings to its warnings. It is read from the text of the composition and from what the page registered, before any render: wall clock (Date.now/performance.now), Math.random, setInterval, CSS transitions, infinite loops, vw/vh units, files that do not exist next to index.html (or sit outside the folder), network resources, an <audio> in the page, transitions that fall outside the piece, audio tracks that never play, fades longer than the track, boosts with no limiter, a gain that looks linear (0–1, which is dB here) and the same file entering several times without offset (a song restarting from 0:00). [error] means the piece will come out wrong — fix it before anything else; [warning] is a suspicion, usually worth a look. "Lint: clean." means nothing to fix; it does not mean the piece is good.

## Name the elements
- Give every element that makes up the scene a data-layer="name" (<div class="ring" data-layer="ring">). Optional, but recommended: it is what lets the piece be cited by name later ("the ring layer enters late", "the title is 6 frames behind the voice"), and it is cheap now and expensive to add afterwards.

## An approved artifact is the spec
When the user approved a look as an artifact (a mockup, a frame, "variation A"), the piece PORTS it: read_artifact, keep its HTML structure, CSS, fonts, colours, spacing and proportions, and only add the motion (the meta format, the seek, the timing). Do not redraw it from memory, and do not change its aspect ratio without asking — a 4:3 card rebuilt as a 9:16 piece is a different design. If the format must change, say so and adapt the layout deliberately (what moves where), keeping every element of the approved one.

## Before saying something is impossible
Read this guide first. Per-track volume, fades, ducking, EQ, a song started from its middle (offset), audio-reactive bars (orbitMotion.audio), backdrop-filter and any modern CSS (the render IS Chromium) all exist. Never tell the user a capability is missing without checking here; when something truly is missing, say exactly what and offer the closest real option.

## Workflow (write → look → iterate → approval → render)
1. motion_write({ name, html }) — creates the composition and opens the Motion tab in the panel so the user can watch it (the tab has play/pause and a slider; it serves the same runtime the render uses, so what the user sees there is what the render produces). Read the result: a composition that did not load is fixed before anything else.
2. Capture 3–5 key instants with motion_frame({ name, times: [0, 0.6, 1.8, 3.4] }) — times in SECONDS: no video file, no encode, and the result tells you what loaded (failed fonts, timing) and, per instant, WHAT IS ON SCREEN read from the page (each visible text, where, how big, its opacity; how many text blocks are invisible). That text is your check — no image needed: "NO visible text" where a title or a lyric should be is a bug (an opacity that never reaches 1, a class with no CSS rule), and so is a caption still on screen after its line was spoken. Cover the entrance, each element landing, the payoff and the hold at the end. Add see: true only when a doubt is visual — the image is slow and costly, and a contact sheet after every edit is how a piece takes forever.
3. Iterate with motion_edit; the tab reloads and comes back to the same instant. Do not re-capture frames to confirm an edit you can read in the HTML.
4. Ask the user to look at it in the panel and say what to change. Their notes can arrive pinned to a frame ("Frame 69 … Selected layer: title … On screen: …") — edit exactly that moment and that element.
5. The video file is NOT part of this loop. The user renders from the Render button of the Motion tab when they are happy. Call motion_render only when they explicitly ask YOU for the file (or you need the clip as an overlay in an EDL), and never post the render in the chat unless asked — the tab is where they watch it.
- Keep the composition folder clean: it is watched for live reload. Renders and contact sheets land outside it by themselves — bring in only what the piece uses.
- Name what matters with data-layer: the Motion tab draws one track per layer with the frames where it enters and leaves. Unnamed elements that appear and disappear show up with their text; naming the phrases/elements makes those tracks (and the user's notes) readable.

## Render (motion_render) — the file is a deliverable, not a step
- DEFAULT: do not render. The Motion tab already shows the piece live, at full quality — that is how the user watches it, and the tab has its own Render button. Call motion_render only when the user asks for the video, or when you need the clip as an overlay in an EDL. Never at the end of a task "to deliver something".
- Never render to look: that is motion_frame's job (3–5 instants, see: true only for a real visual doubt). Never render again for a line of text or a colour — motion_edit changes it and the tab shows it live.
- A render for your OWN analysis, when genuinely unavoidable, is CHEAP: width/height at half the final size, fps 15, quality "small". The user is judging cut, timing and text, not sharpness. The full-size render happens ONCE, when they ask for the file.
- COST: the frames are drawn in an OFFSCREEN window, where Chromium rasterizes in SOFTWARE (the tab uses the GPU). What is expensive is FILL RATE, not your JavaScript — a full-screen canvas, big gradients, blur and shadow filters, and above all MULTISAMPLING. antialias: true in a WebGL context costs nothing in the tab and can multiply the render by 40×: measured here, a 1080×1920 WebGL piece went from 14m45s to 22s by turning it off alone. In a piece that will be rendered, create the context with antialias: false — the frame is captured at the screen scale and reduced by ffmpeg anyway.
- msPerFrame counts ONLY seek + capture + the write to ffmpeg — it does NOT see rasterization. A render that took minutes with a small msPerFrame is fill rate (canvas size, filters, MSAA), not per-frame work in the composition: look there before optimising code.
- quality: "high" | "balanced" | "small" is the FILE's weight (CRF/preset) — it makes the file smaller, not the render faster. Size and fps are what make a render cheap.
- The capture may come at the screen scale (a Retina screen doubles it) and ffmpeg brings the video back to the declared size: declare the size you want and leave the rest to the pipeline, never compensate inside the piece.
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
- WebGL/Canvas/three.js pieces: create the context with antialias: false (and setPixelRatio(1)). MSAA costs nothing in the tab (GPU) and can take a render from seconds to minutes under software rasterization — see "Render", COST.
- Several independent animations? Delegate each to a sub-agent in parallel (subagent tool) with a self-contained brief: the composition name, size/fps/durationInFrames, exact text, the payoff frame, palette, mp4 or alpha. Each worker writes its own piece with motion_write and reports its motion id (mv_…); show each one to the user with motion_preview({ id }).

## Minimal skeleton
motion_write({ name: "title", html }) — with gsap.min.js copied next to it by motion_asset
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

const MOTION_3D = `# 3D in a motion piece (three.js) — read after video_guide("motion")

three.js is NATIVE: write <script type="module"> and import * as THREE from 'three' / from 'three/addons/…' (GLTFLoader, RoomEnvironment, RoundedBoxGeometry…). The runtime already maps those names; never copy three.js into the piece, never load it from a CDN, never use a UMD three.min.js. A 3D piece is NOT a web scene: there is no animation loop, no controls, no clock. The render calls seek(frame) once per frame and draws exactly that frame.

## The shape of every 3D piece: orbit-three
\`orbit-three\` is the helper that owns what breaks a render when done by hand (renderer defaults, the seek, shader warm-up, loading handles, a seeded generator, the camera rig). You write the world and what moves.
<meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=8">   (modules run after parsing: declare the format here too)
<script type="module">
import { mountThree } from 'orbit-three'
mountThree({
  background: '#0b0d12',            // null = transparent canvas (for an alpha overlay)
  fog: { near: 20, far: 90 },       // per-pixel fog in the background colour
  shadows: true,                    // PCF shadow maps; give ONE light castShadow
  fov: 40, near: 0.5, far: 200,
  shots: [                          // the camera rig — see "Cameras and scenes"
    { from: 0,  to: 90,  orbit: { center: [0, 1, 0], radius: { from: 14, to: 9 }, height: { from: 6, to: 2.5 }, angle: { from: 0, to: 1.2 } }, drift: 0.1 },
    { from: 90, to: 180, pos: { from: [6, 1, 8], to: [2, 1.4, 3] }, look: [0, 1, 0], fov: { from: 45, to: 30 }, ease: 'inOut' },
  ],
  setup({ THREE, scene, rng, wait }) {
    // build the world ONCE: geometry, materials, lights. rng(seed) is a seeded generator.
    // async loading: wait(new GLTFLoader().loadAsync('hero.glb').then(...)) holds the seek until it settles.
    const hero = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 2), new THREE.MeshStandardMaterial({ color: '#7c3aed', roughness: 0.35, metalness: 0.2 }))
    scene.add(hero)
    return { hero }                 // available as ctx.state
  },
  update(t, frame, { state, shot }) {
    // everything that moves is a formula of t (seconds); \`shot\` is the index of the current camera shot
    state.hero.rotation.y = t * 0.8
  },
})
</script>
html, body { margin:0; width:1920px; height:1080px; overflow:hidden; background:#000 }
- Defaults it sets for you: antialias false, pixel ratio 1, size = the declared width/height, ACES tone mapping, sRGB output, a RoomEnvironment for reflections (environment: false turns it off), shader compile before the first captured frame.
- Shot fields: from/to (frames), then pos / look / fov (each a value or { from, to }) OR orbit { center, radius, height, angle } (angle in radians, each a value or { from, to }); ease 'inOut' (default) | 'out' | 'in' | 'back' | 'linear'; drift = metres of a slow deterministic sway so a "still" shot is never frozen. Between shots the camera cuts; before the first / after the last it holds.
- Exports: rng, ease, applyShot, if you need them (import { rng } from 'orbit-three').
- Raw three.js with no helper is still possible (import * as THREE from 'three' + your own window.orbitMotion.seek) — then YOU owe every default above: antialias: false, setPixelRatio(1), renderer.compile before the first frame, render inside seek.

## Determinism (the same rules as 2D, with the 3D ways to break them)
- Position, rotation, scale, colour, uniforms = a formula of t. Never mesh.rotation.y += 0.01, never a counter, never lerping "toward" a target frame after frame.
- Randomness: a seeded generator per element (mulberry32(index)), drawn when the world is BUILT, or recomputed from the index every frame. Particles: position = f(seed, t) — never integrate velocity.
- Skeletal / clip animation: action.play(); mixer.setTime(t) — absolute time. mixer.update(dt) accumulates and drifts between bands.
- No Clock, Timer, setAnimationLoop, OrbitControls/damping, physics steps, VideoTexture. A canvas texture redrawn from t inside update() is fine.
- Anything async (GLTFLoader, TextureLoader, FontLoader) sits inside delayRender()/continueRender(); the file comes from motion_asset. Prefer uncompressed or meshopt glTF — Draco needs its decoder files next to the piece.
- Text: put it in HTML above the canvas (crisp, editable, themeable, in the layer list), not as TextGeometry.

## Render cost — fill rate, not triangles (software rasterizer)
- antialias: false and setPixelRatio(1), always. Smooth edges come from rendering at the final size (or 1.5× and letting ffmpeg scale), never from MSAA.
- Budget: < ~200 draw calls (InstancedMesh for repeats, merge static geometry), ONE shadow-casting light with a 1024–2048 map and a tight shadow camera, textures ≤ 2048 and power-of-two, no more than 1–2 post passes (a full-screen pass is a full frame of fill). Skip SSAO, DOF, SSR. Fake glow with additive sprites / emissive + a single bloom pass at most.
- Fog: scene.fog (per pixel). Per-vertex fog bands at the horizon.
- Hide with object.visible = false (or scale 0). An instance parked at y = -9999 still rasterizes and comes back as a stray white polygon.
- z-fighting: raise camera.near first, then separate surfaces by geometry, not by hoping.
- Custom BufferGeometry/shaders: vertexAttribPointer state is GLOBAL — a second buffer (sky dome, particles) can steal attribute 0 from the main program. Give each program explicit attribute locations and re-bind per draw.
- Heights: when you scale terrain, divide when you mean divide (h / 0.4), do not round-trip through Math.round — it flattens the relief.

## Look
- Three-point light: a warm key (the only shadow), a cool low fill, a rim from behind; plus the RoomEnvironment for reflections. A scene lit by one ambient + one directional is the "default three.js" look.
- Every surface gets roughness/metalness decisions; flat MeshBasicMaterial everywhere reads as a wireframe demo. Rounded edges (RoundedBoxGeometry) catch the rim light.
- Background is never a flat colour: gradient sky (a large inverted sphere or a CSS gradient behind a transparent canvas), distance fog in the horizon colour, a ground that fades out.
- Choose a palette first (one dominant, one accent) and tint lights, fog and sky from it.

## Cameras and scenes — the piece must not be one static shot
Write the SHOT LIST before the code (see video_guide("motion-craft")). In 3D that means a camera RIG per shot and a world built so every shot has something to look at:
- A shot = { from, to (frames), position path A→B, look-at path, fov, easing }. camera.position.lerpVectors(a, b, ease(u)); camera.lookAt(lookTarget); camera.fov = …; camera.updateProjectionMatrix(). u = (frame − from) / (to − from), clamped, eased (never linear).
- Vary SCALE, ANGLE and MOVEMENT between consecutive shots (change at least two of: distance, height, direction, fov): aerial establishing → orbit around the hero → push-in on a detail → low-angle reveal → top-down/orthographic → tracking side-on → pull-back finale. Two shots in a row with the same distance and height are one boring shot.
- Movement types: dolly (along the view axis), truck (sideways), orbit (around a pivot), crane (up/down), push-in with a fov change (dolly-zoom for tension), a slow drift on the "still" shots so nothing is ever frozen.
- Cut on movement, or hide the cut behind a DOM flash/wipe overlay with orbitMotion.transition. Scenes of the world are groups whose visible flag is a function of the frame; shared elements (the hero object) can carry through a cut for a match cut.
- Rhythm: a new camera position, a new element or a new beat at least every ~90 frames (3 s); a hold of 15–20 still frames after a big move.

## Looking is allowed here
Unlike 2D, 3D has errors that structure never shows (z-fighting, black sky, wrong exposure, a hidden object peeking in). Take ONE contact sheet per shot — its middle and its last frame, motion_frame with see: true — after the first complete draft, and one more after big changes. Fix what you see, then go back to reading the lint and the call results. Do not loop on screenshots.`

const MOTION_CRAFT = `# Motion craft — direction, not just code (read before the first composition)

A piece that animates is not a piece that looks designed. The "generic AI video" look is: linear easing, opacity-only fades, everything entering together, a flat background, no texture, no holds, one static shot. Each rule below removes one of those.

## Plan before code (write it down, 6–10 lines, before motion_write)
1. Format and length in frames. 2. The palette (a dark or light base, ONE hero colour, one accent, neutrals — the hero colour on at most one element per frame) and the type (a display face at weight 600–800 for heroes, tight tracking −0.03em, a clean sans for the rest; fonts loaded locally). 3. The SHOT LIST: each shot = what is on screen, the camera/composition (wide, medium, detail; angle; movement), its frames, and how it ends (cut, wipe, match cut). 4. Where the audio hits go.
Structure that works for 15–60 s: HOOK (0–1.5 s, the boldest visual, something moves within the first 15 frames) → CONTEXT → BODY in 3–4 beats (each beat: HIT → hold 15–20 still frames → build) → PAYOFF (the biggest animation) → CTA (calm). Something new on screen at least every 90 frames.

## Motion rules
- Never linear. Ease out for entrances (power3.out / cubic-bezier(.16,1,.3,1)), in-out for travels, in for exits. A spring-like overshoot (back.out(1.4)) for playful UI.
- An entrance animates 2–3 properties together (opacity + translateY 30–60px + scale .94→1, or a clip-path/mask reveal). A lone opacity fade is forbidden.
- Stagger: lists, words, cards, rays enter 3–6 frames apart, never together. Words 3, cards 4–5, big blocks 6.
- Exits exist and are faster than entrances (~10 frames vs ~20).
- Holds are a design tool: fast move → complete stillness → next move. Constant motion reads amateur; contrast reads expensive.
- Everything on screen longer than 2 s breathes (a 1–2% scale or a 3px float as a sine of t), every still image gets a slow Ken Burns (scale 1→1.08 + a small pan, alternating in/out between shots).
- Parallax gives depth for free: 3 layers moving at 0.3 / 0.6 / 1× the same travel.
- Fast moves (> 30 px/frame) get a blur ONLY if cheap: a brief filter: blur(8px) on a small element during the move — not on a full-screen layer.
- Timing comes from the frame arithmetic: delays and durations are multiples of fps fractions, with one \`theme\` object at the top of the script (colours, easings, durations, fonts). No inline hex colours scattered through the code.

## Layers of a scene (bottom → top)
background (gradient / mesh / 3D world — never a flat colour) → assets → graphics and type → colour grade (a soft-light tint at 10–25%) → grain + vignette on top. The grade unifies mismatched assets.
COST WARNING (render is a software rasterizer, see video_guide("motion"), Render): the usual recipes for these layers are fill-rate traps. Do NOT use feTurbulence grain, mix-blend-mode over the whole frame, or filter: blur(40px) on a full-screen blob. Instead: a pre-made noise tile (a PNG, e.g. made once with ffmpeg: ffmpeg -f lavfi -i "color=gray:s=256x256,noise=alls=60:allf=t" -frames:v 1 grain.png, brought in with motion_asset) shifted in steps per frame; radial-gradient() backgrounds (they are cheap) instead of blurred divs; one vignette as a radial-gradient overlay.

## Type and layout
- Hero text 80–140 px at 1080 wide (100–160 at 1920). One highlighted word per headline (hero colour, an underline that draws, or a pill that scales in 5 frames after the word lands).
- Pixel gaps (not em) between big text blocks in flex rows: em resolves against the PARENT's font size.
- 9:16: keep critical content inside the middle ~75% vertically — platform UI covers the top and bottom.
- Emoji are not icons (they ignore the palette): draw icons in SVG/CSS with theme colours.
- Numbers count up with font-variant-numeric: tabular-nums.

## Sound is half of it
Never ship a motion piece silent unless asked. Hits get a short whoosh/click starting 2–3 frames BEFORE the visual lands; cuts get a low hit on the cut; a riser leads into a big reveal; a music bed at −18 to −22 dB, ducked under narration (audio.json, "duck"). With no sound library, synthesize a small kit with ffmpeg lavfi (anoisesrc + afade + lowpass for a whoosh, a short sine with a fast decay for a hit/pop) in code mode, or use audio_generate for narration. Pick music FIRST when there is one: framesPerBeat = fps × 60 / BPM, cuts on beats.

## Before saying "done" (the checklist)
- [ ] no linear easing; entrances multi-property and staggered; exits faster
- [ ] a background that is not flat; grade/grain/vignette on top (cheap versions)
- [ ] at least 3 holds; a new element or camera every ≤ 90 frames
- [ ] a shot list with varied scale/angle/movement — not one static composition
- [ ] one hero colour, one highlighted word per headline, hero text ≥ weight 600 in a deliberate face
- [ ] text inside the safe zone; nothing touching the frame edges
- [ ] sound on the major hits (or the user said silent)
- [ ] lint clean; motion_frame at the entrance, each shot, the payoff and the end hold (see: true once per shot for 3D pieces)`

const MOTION_STYLE = `# Recreating the style of a reference video (motion-style)

The goal is the LOOK and the RHYTHM of a reference — never its content or its assets. You rebuild the style with your own text, shapes, footage and 3D; you do not copy its footage, its logos, its music or its artwork. Say that to the user once if they ask for "the same video".

## 1. Read the reference (cheap, in this order)
- video_probe: duration, size, fps, audio. Ask which part of the reference to follow if it is long — a style is read from 15–40 s.
- A reference that PLAYS in a web page and is not a file (YouTube, Vimeo, a site's demo) — code mode, panel tools: panel_navigate to it and read it with panel_sheet({ step: 0.2, see: true }). It seeks the page's own <video> and returns contact sheets (a grid, left to right, top to bottom, the time written on every tile, images only): nothing is downloaded and no ytdlp is needed. 24 frames per sheet; for a 15 s short that is 3 sheets. Read them for what a cut list cannot tell: whether it is cuts or ONE camera, objects that scale up past the frame and become the next background, wipes made of shapes, layers moving at different speeds. Then a second pass with a small step (0.05–0.1) over the one move you want to copy to read its easing, and tile: 360 for small type. An animation or canvas that is not a <video> uses mode "seek" with a seekCode that sets time t. If the site blocks reading the video (the tool says so), say it and ask the user for the file; do not work around it.
- CUTS (code mode, ffmpeg on the PATH): the cut list gives the rhythm.
  ffmpeg -hide_banner -i ref.mp4 -vf "select='gt(scene,0.3)',showinfo" -an -f null - 2>&1 | grep -o "pts_time:[0-9.]*"
  Average shot length = duration / (cuts + 1). Lower the threshold to 0.15–0.2 for soft dissolves; the list is cut times, so differences are shot lengths. Short, equal shots = a beat-driven edit; long and uneven = a documentary rhythm.
- PALETTE: the average colour of one frame per second, as hex (the video's overall grade and its dominant tones):
  ffmpeg -v error -i ref.mp4 -vf "fps=1,scale=1:1" -f rawvideo -pix_fmt rgb24 - | xxd -p -c3
  Then look at 3–4 frames with video_timeline (hook, middle, payoff, end) and pick the base, the hero colour and the accent BY EYE from them — the averages tell you the grade and the contrast, the frames tell you which colour is the hero.
- MOTION ENERGY: how much changes between frames, per half second (high = fast kinetic edit, low = calm):
  ffmpeg -hide_banner -i ref.mp4 -vf "fps=2,signalstats,metadata=print:key=lavfi.signalstats.YDIF" -an -f null - 2>&1 | grep YDIF
- WORDS and timing of any text/narration: transcribe({ detail: "words" }) when it speaks; the pacing of the words is part of the style.
- TEMPO and BEATS of the music: audio_bpm({ path, fps }) returns the bpm, a confidence, the double/half-time readings, framesPerBeat and the real beat times. Compare them with the cut list: cuts that fall on the beat times = a beat-driven edit. Never assume 120 bpm.
- Chat mode has no bash: video_timeline windows (and transcribe) are the whole toolset — take more windows instead of cut detection.

## 2. Write the STYLE BRIEF (10–15 lines) and show it before building
- Format: aspect, fps, length, structure (hook / body / payoff, with the times of each from the cut list).
- Rhythm: average shot length, fastest and slowest shot, where the holds are, whether cuts land on a beat (bpm from the music, framesPerBeat = fps × 60 / bpm).
- Palette: base, hero, accent, text (hex) + the grade (warm / cool / crushed blacks / lifted blacks / saturated / desaturated) + grain, vignette, glow, halation: yes or no.
- Type: the category (grotesque, serif, mono, handwritten), weight, case, tracking, size relative to the frame, how it enters (per word, per line, a mask reveal, a scale-pop), how it leaves. Name a free font from the same family (Google Fonts) — fonts are never identified by guess; say it is the nearest match.
- Camera / composition: shot scales in order, camera moves (push-in, whip, orbit, handheld sway), depth (parallax layers, 3D), symmetry vs asymmetry, safe zones.
- Motion language: the easing (snappy-out / floaty / overshoot), the stagger, the transition vocabulary (hard cut, whip, wipe, zoom-through, glitch, iris), the typical duration of an entrance in frames.
- Sound: music genre and tempo, the SFX on hits, silence moments.
Then ASK the user to confirm or correct it — two lines of corrections now save a rebuilt piece.

## 3. Build from the brief
- Turn the brief into a \`theme\` object (colours, easings, durations, fonts) and a SHOT LIST with frame numbers measured from the reference cut list, scaled to your piece's length (video_guide("motion-craft")). Keep the reference's proportions: if its hook is 8% of the length, so is yours.
- Choose the technique that gives the look at a render cost the software rasterizer can pay: kinetic type and shapes in HTML/GSAP; depth, objects and camera moves in three.js (video_guide("motion-3d")); a photo/footage style with Ken Burns and a grade layer. A glitch, a film burn or a grain is a pre-made PNG/WebM looped in steps, not a full-screen SVG filter.
- Transitions are the signature: reproduce the reference's own (orbitMotion.transition covers fade / push / cover / reveal / wipe / zoom / blur / iris; a whip is orbitMotion.camera's style 'whip'; a zoom-through is camera.zoomThrough). FIRST decide which kind of piece the reference is: cuts between scenes (transition), or ONE continuous camera through a flat world where an object grows to fill the frame and becomes the next background, layers fly past at different speeds and the camera slings to the next spot (camera, see "Camera" in video_guide("motion")). Most kinetic-type edits and app tours are the second kind: look for objects that scale up past the frame and for a pull-back that reveals them.

## 4. Check against the reference, not against your taste
After the first draft take the SAME instants of both (hook, a mid beat, the payoff) — video_timeline on the reference, motion_frame (see: true, once) on your piece — and compare: palette, scale of the type, density of the frame, shot length. Fix the biggest difference first. State what you matched and what you could not (a licensed font, a footage-specific look) instead of claiming it is identical.`

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

export const VIDEO_GUIDES = {
  editing: EDITING,
  motion: MOTION,
  'motion-3d': MOTION_3D,
  'motion-craft': MOTION_CRAFT,
  'motion-style': MOTION_STYLE,
  remotion: REMOTION,
} as const
export type VideoGuideTopic = keyof typeof VIDEO_GUIDES
