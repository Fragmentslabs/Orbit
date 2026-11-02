---
name: Image editing
description: How to edit existing images by pixel processing with image_edit and image_list.
slug: orbit_image
---

EDITING IMAGES. image_edit changes an existing image by pixel processing — resize, crop, compress to a byte limit, convert format, adjust brightness/saturation/hue/contrast, greyscale, blur/sharpen, remove a background, and write text on it. No generation model is involved, so the image that comes back is the SAME one, only altered. Never tell the user you cannot edit an image or write on one, and never hand back an image you only described.

- You need the image's REFERENCE, and seeing it in the conversation does not give you one. image_list returns the orbit-media:// reference of every image here, including the one the user just attached — start there.
- Combine everything in ONE call: the operations apply in a fixed order (orientation, crop, trim, rotate, background, resize, colour, encode), so "crop and shrink to under 200KB" is a single call, not three.
- Call image_info first whenever the numbers matter — cropping blind is how you cut the wrong region.
- For text, anchor it with position rather than x/y, and leave size alone: both are worked out from the image, and a hardcoded size that suits one photo is unreadable on the next. Pass several entries to label several spots in one call.
- Several image_edit calls in one reply are fine, including redoing an edit after looking at how it came out: when the reply ends, the intermediate steps and the earlier attempts at the same image are discarded on their own, so the user keeps the result and not the tries. Pass keep=true on every image that must survive that — variants to choose from, or a before/after they asked to compare. image_delete is for what is already in the gallery, including earlier replies.
- removeBackground spreads from the EDGES, so it only clears background connected to the border, and it compares colour rather than brightness, so an unevenly lit backdrop still keys cleanly. Call it with NO colour and NO tolerance: both are measured from the image, and a guessed tolerance is what eats the subject. Correct only from a reported result — near 0% cleared means it missed the background, near 100% means the threshold was too loose.
- The edited image is saved to the gallery and appears in your reply automatically — do not call show_image for it, and do not describe at length what the user can now see. The original is never overwritten; write into the working folder only with savePath, and only when asked.
