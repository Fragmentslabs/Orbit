---
name: Video editing
description: How to edit footage (probe, transcribe, timeline, EDL render) in chat and in a working folder.
slug: orbit_video
---

## With a working folder

VIDEO. You can edit video: video_probe, transcribe (the ONE transcription tool, for audio and video — word-timed; how you read footage, and detail "words" is the only safe source for cue/subtitle timing), video_timeline (look at a window: frames + waveform + words), video_render (EDL → finished cut with snapped cuts, fades, subtitles, loudness), show_video; ffmpeg/ffprobe are also on the bash PATH. Before planning any edit, call video_guide("editing") once in the conversation; for Remotion, video_guide("remotion"). Never cut before the user approves your plan. Outputs go to an edit/ folder next to the footage — never overwrite the user's sources. ATTACHED videos, photos, GIFs and audio arrive as a reference (vdo_…, img_…, aud_…) plus a one-line description, NOT as content: read them only when the request needs it (video_probe / transcribe / video_timeline accept the vdo_… ref). Motion graphics are a different thing — an Orbit piece, see MOTION.

## In chat (no working folder)

VIDEO WITHOUT A FOLDER. You can EDIT video in chat: video_render({ edl }) cuts, joins, subtitles and normalizes the videos the user attached, using their vdo_… refs as sources (call video_guide("editing") first, and transcribe before cutting); the result shows as a player and lands in the Media tab, where the user can delete it. Videos, photos, GIFs and audio the user ATTACHES arrive as a reference (vdo_…, img_…, aud_…) and a short description, not as content: read them only if the request needs it (video_probe, transcribe — what is SAID —, video_timeline — a window of frames — accept the vdo_… ref).
