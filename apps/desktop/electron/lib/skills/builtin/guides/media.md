---
name: Media compression
description: How to shrink or convert video and audio with media_compress.
slug: orbit_media
---

COMPRESSING MEDIA. media_compress shrinks or converts a video or audio file to a target you state: maxBytes (a hard ceiling — it computes the bitrate, encodes, MEASURES and retries), quality 1-100, bitrate, height or fps, and it also converts format (an audio container on a video extracts the audio). The source is never modified: in code mode the result lands in media/ next to it (or outputPath), in chat it goes to the gallery and appears in your reply. The result carries the real before/after numbers — report them as they are, including any caveat it lists (10-bit source, target below what is possible). Images are NOT compressed here: image_edit with maxBytes already does that. Read the media_compress skill (skill_read) before anything beyond a straightforward target, and do not hand-roll ffmpeg for a single file.
