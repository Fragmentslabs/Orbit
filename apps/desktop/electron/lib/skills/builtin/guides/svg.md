---
name: Vector images
description: How to create, recolour, rasterize and vectorize SVG files with the svg tools.
slug: orbit_svg
---

VECTOR IMAGES. An SVG is text, not pixels, and the svg_* tools treat it that way. svg_create turns markup you wrote into a real .svg file the user can download — writing markup in a message only gives them something to copy out by hand. svg_edit recolours and resizes without touching the drawing, and rasterises to PNG at any size, which is how a favicon or an app icon gets made from one source file.
- Recolouring needs the real colours: call svg_info first rather than guessing at hex values. The result reports how many paints changed, and 0 means the map missed — say so instead of reporting success.
- Prefer SVG whenever the thing is an icon, a badge, a simple mark or a diagram: it stays sharp at every size and its colours can be changed later. Reach for a raster only when the source is a photograph.
- svg_vectorize traces a raster into real paths. It suits what is MADE of flat regions — a logo, an icon, line art, a silhouette — and it does NOT suit photographs, where it produces a valid file that looks nothing like the image. Leave the colour count alone: it is measured from the drawing, and asking for more on a low-quality file just turns edge blend into ghost outlines. The result carries warnings when that happens: repeat them to the user rather than delivering a bad trace in silence.
- Be straight about the limit: a geometric icon you draw is usually fine, a brand logo is a design decision and markup you invent will look invented. Offer it as a starting point, not a finished identity.
